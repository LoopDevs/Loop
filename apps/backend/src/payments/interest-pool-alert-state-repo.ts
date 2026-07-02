/**
 * Persistence for the interest-pool low-cover watcher's per-asset
 * alert state (hardening C10a; ADR 031).
 *
 * Single-dimension sibling of `asset-drift-state-repo.ts`. The low↔ok
 * transition dedup previously lived in a process-memory Set inside the
 * notifiers: lost on restart (every deploy re-paged an ongoing
 * low-cover window) and — the real bug — per-machine, so the machine
 * that computed "recovered" was usually NOT the one that had paged
 * "low", and its empty Set made `notifyInterestPoolRecovered`
 * early-return, silently dropping the close. This repo makes the state
 * durable + fleet-consistent and page delivery AT-LEAST-ONCE:
 *
 *   - `state` says what IS (ok / low).
 *   - `last_paged_state` says what ops KNOWS — moved only after the
 *     webhook confirms (`markPoolPageDelivered`).
 *   - A page is DUE when the two diverge; a send lost to a Discord
 *     outage or a SIGTERM stays due and is retried by any machine.
 *   - `page_attempt_at` is a short lease claimed under the row lock so
 *     concurrent machines don't double-page; an expired lease
 *     (crashed sender) re-opens the claim.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { interestPoolAlertState } from '../db/schema.js';

/** See `asset-drift-state-repo.PAGE_ATTEMPT_LEASE_MS` — same rationale. */
export const POOL_PAGE_ATTEMPT_LEASE_MS = 4 * 60_000;

/** The single alert transition this watcher can owe ops. */
export type PoolDuePage = 'low' | 'recovered' | undefined;

/**
 * Pure due-page derivation — exported so the watcher's unit suite
 * exercises the real decision against an in-memory emulation.
 * `recovered` is only ever due when ops SAW the `low` open (an
 * low→ok blip never delivered is elided, same as the old Set).
 */
export function computePoolDuePage(args: {
  state: 'ok' | 'low';
  lastPagedState: 'ok' | 'low' | null;
}): PoolDuePage {
  if (args.state === 'low' && args.lastPagedState !== 'low') return 'low';
  if (args.state === 'ok' && args.lastPagedState === 'low') return 'recovered';
  return undefined;
}

export interface ApplyPoolStateResult {
  /** State the row held before this write ('unknown' = row absent). */
  prior: 'ok' | 'low' | 'unknown';
  /**
   * True when a concurrent writer created the first row between our
   * read and insert. The sample was not persisted; no page claimed.
   */
  raced: boolean;
  /**
   * The page this caller claimed and must now send. `undefined` when
   * nothing is due or another machine holds a fresh lease. On delivery
   * call `markPoolPageDelivered`; on a failed send call
   * `releasePoolPageLease` so the next tick retries immediately.
   */
  duePage: PoolDuePage;
}

/**
 * Persist one asset's cover sample and claim any due page, all under
 * the same row lock so the transition/paging decision is race-free
 * across machines.
 */
export async function applyPoolAlertState(args: {
  assetCode: string;
  state: 'ok' | 'low';
  daysOfCover: number;
  poolStroops: bigint;
  checkedAt: Date;
}): Promise<ApplyPoolStateResult> {
  // `Infinity` days-of-cover (daily interest 0) can't round-trip to a
  // double column cleanly; clamp to a large sentinel. The state is
  // still 'ok' so it never pages.
  const daysForStore = Number.isFinite(args.daysOfCover) ? args.daysOfCover : 1e9;
  return await db.transaction(async (tx) => {
    const [prior] = await tx
      .select()
      .from(interestPoolAlertState)
      .where(eq(interestPoolAlertState.assetCode, args.assetCode))
      .for('update');

    if (prior === undefined) {
      const due = computePoolDuePage({ state: args.state, lastPagedState: null });
      const inserted = await tx
        .insert(interestPoolAlertState)
        .values({
          assetCode: args.assetCode,
          state: args.state,
          lastDaysOfCover: daysForStore,
          lastPoolStroops: args.poolStroops,
          pageAttemptAt: due !== undefined ? new Date() : null,
          lastCheckedAt: args.checkedAt,
        })
        .onConflictDoNothing({ target: interestPoolAlertState.assetCode })
        .returning({ assetCode: interestPoolAlertState.assetCode });
      if (inserted.length === 0) {
        return { prior: 'unknown', raced: true, duePage: undefined };
      }
      return { prior: 'unknown', raced: false, duePage: due };
    }

    // Staleness fence: refuse a sample older than the persisted row.
    if (prior.lastCheckedAt > args.checkedAt) {
      return { prior: prior.state, raced: true, duePage: undefined };
    }

    const due = computePoolDuePage({ state: args.state, lastPagedState: prior.lastPagedState });
    const now = Date.now();
    const leaseFresh =
      prior.pageAttemptAt !== null &&
      now - prior.pageAttemptAt.getTime() < POOL_PAGE_ATTEMPT_LEASE_MS;
    const claim = due !== undefined && !leaseFresh;

    await tx
      .update(interestPoolAlertState)
      .set({
        state: args.state,
        lastDaysOfCover: daysForStore,
        lastPoolStroops: args.poolStroops,
        ...(claim ? { pageAttemptAt: new Date() } : {}),
        lastCheckedAt: args.checkedAt,
        updatedAt: sql`NOW()`,
      })
      .where(eq(interestPoolAlertState.assetCode, args.assetCode));

    return { prior: prior.state, raced: false, duePage: claim ? due : undefined };
  });
}

/**
 * Record successful page delivery: `last_paged_state` moves to the
 * just-sent state and the lease clears. `low` page → 'low',
 * `recovered` page → 'ok'.
 */
export async function markPoolPageDelivered(args: {
  assetCode: string;
  page: 'low' | 'recovered';
}): Promise<void> {
  await db
    .update(interestPoolAlertState)
    .set({
      lastPagedState: args.page === 'low' ? 'low' : 'ok',
      pageAttemptAt: null,
      updatedAt: sql`NOW()`,
    })
    .where(eq(interestPoolAlertState.assetCode, args.assetCode));
}

/**
 * Release the send-attempt lease after a failed send so the next tick
 * (any machine) retries immediately instead of waiting out the lease.
 */
export async function releasePoolPageLease(assetCode: string): Promise<void> {
  await db
    .update(interestPoolAlertState)
    .set({ pageAttemptAt: null, updatedAt: sql`NOW()` })
    .where(eq(interestPoolAlertState.assetCode, assetCode));
}
