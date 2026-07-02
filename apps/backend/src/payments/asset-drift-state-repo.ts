/**
 * Persistence for the asset-drift watcher's per-asset state
 * (hardening A2/A3; ADR 015 / 036).
 *
 * The watcher's transition state (ok↔over, failed-rows none↔present)
 * previously lived in process memory: lost on restart and duplicated
 * per Fly machine, so every deploy re-paged ongoing incidents and
 * each machine paged independently. This repo makes the state
 * durable and fleet-consistent, and makes page delivery
 * AT-LEAST-ONCE instead of fire-and-forget:
 *
 *   - The `state` / `failed_rows_state` columns say what IS.
 *   - The `last_paged_*` columns say what ops KNOWS — written only
 *     after `sendWebhook` confirms delivery (`markPagesDelivered`).
 *   - A page is DUE whenever the two diverge ({@link computeDuePages}).
 *     A send lost to a Discord outage or a SIGTERM between the state
 *     commit and the send stays due and is re-attempted on later
 *     ticks by any machine.
 *   - `page_attempt_at` is a short lease claimed under the row lock,
 *     so concurrently-ticking machines don't double-page; an expired
 *     lease (crashed sender) re-opens the claim.
 *
 * Writes are serialised through `SELECT ... FOR UPDATE` (or
 * `INSERT ... ON CONFLICT DO NOTHING` for an asset's first row — the
 * loser of a concurrent first-insert gets `raced: true`). A sample
 * computed from reads OLDER than the persisted row's
 * `last_checked_at` is refused (`stale: true`) so a slow machine
 * can't overwrite a newer sample with inverted state.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { assetDriftState } from '../db/schema.js';
import type { AssetDriftState, AssetFailedRowsState } from '@loop/shared';

/**
 * How long a send-attempt lease blocks other machines from
 * re-claiming the same due pages. Longer than any realistic send
 * (5s webhook timeout × 4 pages) and shorter than two default
 * watcher ticks, so a crashed sender delays a page by at most one
 * extra tick.
 */
export const PAGE_ATTEMPT_LEASE_MS = 4 * 60_000;

/** One asset's persisted watcher state (row absent = 'unknown'). */
export interface PersistedDriftState {
  state: 'ok' | 'over';
  failedRowsState: 'none' | 'present';
  lastDriftStroops: bigint;
  lastThresholdStroops: bigint;
  failedBurnStroops: bigint;
  failedInterestMintStroops: bigint;
  lastCheckedAt: Date;
}

/**
 * Pages due for an asset: the divergence between what IS and what
 * ops has been paged about. `drift: 'over'` opens the drift
 * incident, `'recovered'` closes it (only ever due when ops SAW the
 * open — an over→ok blip that was never delivered is elided, same
 * as the old in-memory watcher eliding flips between ticks).
 */
export interface DuePages {
  drift?: 'over' | 'recovered';
  failedRows?: 'present' | 'cleared';
}

/**
 * Pure due-page derivation — exported so the watcher's unit suite
 * exercises the real decision logic against its in-memory repo
 * emulation.
 */
export function computeDuePages(args: {
  state: 'ok' | 'over';
  failedRowsState: 'none' | 'present';
  lastPagedState: 'ok' | 'over' | null;
  lastPagedFailedRowsState: 'none' | 'present' | null;
}): DuePages {
  const due: DuePages = {};
  if (args.state === 'over' && args.lastPagedState !== 'over') {
    due.drift = 'over';
  } else if (args.state === 'ok' && args.lastPagedState === 'over') {
    due.drift = 'recovered';
  }
  if (args.failedRowsState === 'present' && args.lastPagedFailedRowsState !== 'present') {
    due.failedRows = 'present';
  } else if (args.failedRowsState === 'none' && args.lastPagedFailedRowsState === 'present') {
    due.failedRows = 'cleared';
  }
  return due;
}

export interface ApplyDriftStateResult {
  /**
   * The state the row held BEFORE this write ('unknown' when the row
   * didn't exist). Reported on the tick sample for observability.
   */
  prior: {
    state: AssetDriftState;
    failedRowsState: AssetFailedRowsState;
  };
  /**
   * True when a concurrent writer created the asset's first row
   * between our read and insert, or when this sample's reads are
   * older than the persisted row (a slower machine lost the race).
   * The caller's sample was not persisted and no pages were claimed.
   */
  raced: boolean;
  /**
   * Pages this caller has claimed and must now attempt to send.
   * Empty when nothing is due or another machine holds a fresh
   * send-attempt lease. On delivery call `markPagesDelivered`; on a
   * failed send call `releasePageLease` so the next tick retries
   * immediately instead of waiting out the lease.
   */
  duePages: DuePages;
}

/**
 * Persist one asset's sample and claim any due pages, all under the
 * same row lock so the transition/paging decision is race-free
 * across machines.
 */
export async function applyDriftState(
  args: { assetCode: string } & PersistedDriftState,
): Promise<ApplyDriftStateResult> {
  return await db.transaction(async (tx) => {
    const [prior] = await tx
      .select()
      .from(assetDriftState)
      .where(eq(assetDriftState.assetCode, args.assetCode))
      .for('update');

    if (prior === undefined) {
      const due = computeDuePages({
        state: args.state,
        failedRowsState: args.failedRowsState,
        lastPagedState: null,
        lastPagedFailedRowsState: null,
      });
      const hasDue = due.drift !== undefined || due.failedRows !== undefined;
      const inserted = await tx
        .insert(assetDriftState)
        .values({
          assetCode: args.assetCode,
          state: args.state,
          failedRowsState: args.failedRowsState,
          lastDriftStroops: args.lastDriftStroops,
          lastThresholdStroops: args.lastThresholdStroops,
          failedBurnStroops: args.failedBurnStroops,
          failedInterestMintStroops: args.failedInterestMintStroops,
          pageAttemptAt: hasDue ? new Date() : null,
          lastCheckedAt: args.lastCheckedAt,
        })
        .onConflictDoNothing({ target: assetDriftState.assetCode })
        .returning({ assetCode: assetDriftState.assetCode });
      if (inserted.length === 0) {
        // Lost a concurrent first-insert race. Leave the winner's row
        // untouched this tick — the next tick updates it normally.
        return {
          prior: { state: 'unknown', failedRowsState: 'unknown' },
          raced: true,
          duePages: {},
        };
      }
      return {
        prior: { state: 'unknown', failedRowsState: 'unknown' },
        raced: false,
        duePages: due,
      };
    }

    // Staleness fence: this sample was computed from reads started at
    // `args.lastCheckedAt`; if the row already carries a STRICTLY
    // newer sample, persisting ours would overwrite fresh state with
    // stale sums (and could page a transition that already
    // un-happened). Equal timestamps are allowed through — the fence
    // targets a machine whose reads are seconds older, not same-ms
    // writers (dedup for those is the lease + last_paged columns).
    if (prior.lastCheckedAt > args.lastCheckedAt) {
      return {
        prior: { state: prior.state, failedRowsState: prior.failedRowsState },
        raced: true,
        duePages: {},
      };
    }

    const due = computeDuePages({
      state: args.state,
      failedRowsState: args.failedRowsState,
      lastPagedState: prior.lastPagedState,
      lastPagedFailedRowsState: prior.lastPagedFailedRowsState,
    });
    const hasDue = due.drift !== undefined || due.failedRows !== undefined;
    const now = Date.now();
    const leaseFresh =
      prior.pageAttemptAt !== null && now - prior.pageAttemptAt.getTime() < PAGE_ATTEMPT_LEASE_MS;
    const claim = hasDue && !leaseFresh;

    await tx
      .update(assetDriftState)
      .set({
        state: args.state,
        failedRowsState: args.failedRowsState,
        lastDriftStroops: args.lastDriftStroops,
        lastThresholdStroops: args.lastThresholdStroops,
        failedBurnStroops: args.failedBurnStroops,
        failedInterestMintStroops: args.failedInterestMintStroops,
        // Claiming stamps a fresh lease; a non-claiming write leaves
        // any existing lease untouched (its holder is mid-send).
        ...(claim ? { pageAttemptAt: new Date() } : {}),
        lastCheckedAt: args.lastCheckedAt,
        updatedAt: sql`NOW()`,
      })
      .where(eq(assetDriftState.assetCode, args.assetCode));

    return {
      prior: { state: prior.state, failedRowsState: prior.failedRowsState },
      raced: false,
      duePages: claim ? due : {},
    };
  });
}

/**
 * Record successful page delivery: `last_paged_*` moves to what was
 * just sent and the send-attempt lease clears. Written per-dimension
 * so one delivered page out of two isn't lost when the other fails.
 */
export async function markPagesDelivered(args: {
  assetCode: string;
  /** Drift state ops was just paged about (maps 'recovered' → 'ok'). */
  drift?: 'ok' | 'over';
  /** Failed-rows state ops was just paged about (maps 'cleared' → 'none'). */
  failedRows?: 'none' | 'present';
}): Promise<void> {
  await db
    .update(assetDriftState)
    .set({
      ...(args.drift !== undefined ? { lastPagedState: args.drift } : {}),
      ...(args.failedRows !== undefined ? { lastPagedFailedRowsState: args.failedRows } : {}),
      pageAttemptAt: null,
      updatedAt: sql`NOW()`,
    })
    .where(eq(assetDriftState.assetCode, args.assetCode));
}

/**
 * Release the send-attempt lease after a failed send so the next
 * tick (any machine) retries immediately instead of waiting out
 * {@link PAGE_ATTEMPT_LEASE_MS}. A crash skips this and the lease
 * expiry covers it.
 */
export async function releasePageLease(assetCode: string): Promise<void> {
  await db
    .update(assetDriftState)
    .set({ pageAttemptAt: null, updatedAt: sql`NOW()` })
    .where(eq(assetDriftState.assetCode, assetCode));
}

/**
 * All persisted per-asset states, keyed by asset code. Assets with no
 * row have never been successfully read (state 'unknown' at the API
 * layer). Fleet-wide: any machine's admin request sees the same rows.
 */
export async function listPersistedDriftStates(): Promise<Map<string, PersistedDriftState>> {
  const rows = await db.select().from(assetDriftState);
  return new Map(
    rows.map((r) => [
      r.assetCode,
      {
        state: r.state,
        failedRowsState: r.failedRowsState,
        lastDriftStroops: r.lastDriftStroops,
        lastThresholdStroops: r.lastThresholdStroops,
        failedBurnStroops: r.failedBurnStroops,
        failedInterestMintStroops: r.failedInterestMintStroops,
        lastCheckedAt: r.lastCheckedAt,
      },
    ]),
  );
}
