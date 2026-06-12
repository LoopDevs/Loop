/**
 * Redemption-backfill sweeper (comprehensive audit 2026-06-11
 * §redemption follow-up to the 2026-05-14 e2e finding).
 *
 * `waitForRedemption` (procurement-redemption.ts) can exhaust its
 * budget while CTX is still issuing — the procurement worker then
 * marks the order `fulfilled` with `redeem_code / redeem_pin /
 * redeem_url` all NULL, and (before this module) nothing ever
 * re-fetched them. The user paid; the "Ready" screen has nothing to
 * show.
 *
 * This sweeper periodically finds fulfilled orders that captured a
 * `ctx_order_id` but no redemption payload, re-runs `fetchRedemption`
 * per order through the operator pool, and persists any recovered
 * fields. Per-order bookkeeping (migration 0034):
 *
 *   - `redemption_backfill_attempts` — bumped on every empty /
 *     failed attempt; drives the exponential-ish backoff
 *     (1 min · 2^attempts, capped at 8 h) and the hard cap of
 *     `REDEMPTION_BACKFILL_MAX_ATTEMPTS` (10).
 *   - `redemption_backfill_last_attempt_at` — anchor for the
 *     backoff's next-due computation.
 *
 * When an order crosses the cap still empty, ops is paged once via
 * `notifyRedemptionBackfillExhausted` (Discord monitoring channel) —
 * runbook: docs/runbooks/redemption-backfill-exhausted.md.
 *
 * Wiring follows the sibling sweeps (`sweepStuckProcurement`,
 * `sweepExpiredOrders`): a `start…/stop…` timer pair gated in
 * `index.ts` on `LOOP_WORKERS_ENABLED`, with per-tick errors
 * swallowed so a transient CTX / DB blip doesn't kill the interval.
 */
import { and, eq, isNull, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { logger } from '../logger.js';
import { notifyRedemptionBackfillExhausted } from '../discord.js';
import { OperatorPoolUnavailableError, OperatorRateLimitedError } from '../ctx/operator-pool.js';
import { fetchRedemption } from './procurement-redemption.js';
import { encryptRedeemField } from './redeem-crypto.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';

const log = logger.child({ area: 'redemption-backfill' });

/**
 * Hard cap on backfill attempts per order. With the backoff schedule
 * below the tenth attempt lands ~17 h after fulfillment — long past
 * any plausible CTX issuance latency. Beyond that the row is a
 * supplier-side problem, not a retry problem; ops is paged instead.
 */
export const REDEMPTION_BACKFILL_MAX_ATTEMPTS = 10;

/**
 * Backoff base: the delay before attempt n+1 is `base · 2^n`, so
 * 1 min, 2 min, 4 min, … capped at `REDEMPTION_BACKFILL_MAX_DELAY_MS`.
 * Attempt 0 (first backfill after fulfillment) is due immediately —
 * `last_attempt_at IS NULL` short-circuits the gate.
 */
const REDEMPTION_BACKFILL_BASE_DELAY_MS = 60_000;
const REDEMPTION_BACKFILL_MAX_DELAY_MS = 8 * 60 * 60 * 1000;

/** How often the sweeper polls. Mirrors the stuck-procurement sweep. */
export const REDEMPTION_BACKFILL_INTERVAL_MS = 60_000;

/** Max candidate rows considered per tick. */
const REDEMPTION_BACKFILL_BATCH_LIMIT = 20;

/** Delay before the (attempts+1)-th attempt is due. Exported for tests. */
export function redemptionBackfillDelayMs(attempts: number): number {
  const exp = Math.min(attempts, 30); // 2^30 guard against overflow noise
  return Math.min(REDEMPTION_BACKFILL_BASE_DELAY_MS * 2 ** exp, REDEMPTION_BACKFILL_MAX_DELAY_MS);
}

export interface RedemptionBackfillTickResult {
  /** Candidate rows matched by the SQL filter (pre-backoff). */
  picked: number;
  /** Rows skipped because their backoff window hasn't elapsed yet. */
  notDueYet: number;
  /** Rows where the re-fetch recovered at least one redemption field. */
  recovered: number;
  /** Rows re-fetched but still empty (attempts bumped). */
  stillEmpty: number;
  /** Rows that crossed the attempts cap this tick (Discord alert fired). */
  exhausted: number;
  /** Rows whose fetch threw a non-pool error (attempts bumped). */
  errors: number;
  /** True when the tick aborted early on a pool-wide operator outage. */
  abortedPoolUnavailable: boolean;
}

/**
 * Single sweep pass. Safe to call repeatedly — the WHERE guards on
 * the persist UPDATE mean a concurrent writer (or a second sweeper)
 * can't double-write or clobber a payload that landed in between.
 *
 * CF-14 (x-concurrency-financial X-2) cross-instance safety: already
 * safe without `SKIP LOCKED`. The candidate `SELECT` is a plain read,
 * but every mutation is a guarded compare-and-set: the recovery UPDATE
 * re-asserts `state='fulfilled' AND redeem* IS NULL`, and
 * `recordEmptyAttempt` CAS-es on `redemptionBackfillAttempts =
 * row.attempts`. So when two Fly machines run this sweep at once they
 * may both re-`fetchRedemption` the same `ctx_order_id` (an idempotent,
 * read-only supplier call — wasted cost, no money/correctness bug) but
 * exactly one wins the attempt bump and the at-cap page. No shared
 * sequenced resource, no double-process.
 */
export async function runRedemptionBackfillTick(args?: {
  limit?: number;
  now?: number;
}): Promise<RedemptionBackfillTickResult> {
  const now = args?.now ?? Date.now();
  const result: RedemptionBackfillTickResult = {
    picked: 0,
    notDueYet: 0,
    recovered: 0,
    stillEmpty: 0,
    exhausted: 0,
    errors: 0,
    abortedPoolUnavailable: false,
  };

  // Matches the partial index `orders_redemption_backfill_pending`
  // (migration 0034) plus the code-side attempts cap. Oldest
  // fulfillment first so a long-stuck order isn't starved by newer
  // ones when the batch limit bites.
  const rows = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      merchantId: orders.merchantId,
      ctxOrderId: orders.ctxOrderId,
      fulfilledAt: orders.fulfilledAt,
      attempts: orders.redemptionBackfillAttempts,
      lastAttemptAt: orders.redemptionBackfillLastAttemptAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.state, 'fulfilled'),
        isNotNull(orders.ctxOrderId),
        isNull(orders.redeemCode),
        isNull(orders.redeemPin),
        isNull(orders.redeemUrl),
        lt(orders.redemptionBackfillAttempts, REDEMPTION_BACKFILL_MAX_ATTEMPTS),
      ),
    )
    .orderBy(orders.fulfilledAt)
    .limit(args?.limit ?? REDEMPTION_BACKFILL_BATCH_LIMIT);
  result.picked = rows.length;

  for (const row of rows) {
    // ctxOrderId is guaranteed non-null by the SQL filter; the
    // narrow keeps TypeScript honest without a non-null assertion.
    if (row.ctxOrderId === null) continue;

    // Backoff gate, evaluated in code so the schedule lives next to
    // the constants rather than in a SQL interval expression.
    if (
      row.lastAttemptAt !== null &&
      now - row.lastAttemptAt.getTime() < redemptionBackfillDelayMs(row.attempts)
    ) {
      result.notDueYet++;
      continue;
    }

    let redemption: { code: string | null; pin: string | null; url: string | null };
    try {
      redemption = await fetchRedemption(row.ctxOrderId);
    } catch (err) {
      if (err instanceof OperatorPoolUnavailableError || err instanceof OperatorRateLimitedError) {
        // Pool-wide outage or CTX rate-limit (CF-12) — every subsequent
        // row would hit the same wall. Abort WITHOUT bumping attempts:
        // this is our-side back-pressure / outage, not evidence that
        // CTX has no payload for the order, and it shouldn't consume
        // the order's retry budget.
        log.warn(
          { orderId: row.id, rateLimited: err instanceof OperatorRateLimitedError },
          'Operator pool unavailable / rate-limited — aborting redemption-backfill tick without burning attempts',
        );
        result.abortedPoolUnavailable = true;
        break;
      }
      log.warn(
        { orderId: row.id, ctxOrderId: row.ctxOrderId, err: errMessage(err) },
        'Redemption backfill fetch failed — attempt recorded, will retry with backoff',
      );
      result.errors++;
      await recordEmptyAttempt(row, now, result);
      continue;
    }

    if (redemption.code !== null || redemption.pin !== null || redemption.url !== null) {
      if (await persistRecoveredRedemption(row, redemption, now)) {
        result.recovered++;
      }
      continue;
    }

    result.stillEmpty++;
    await recordEmptyAttempt(row, now, result);
  }

  return result;
}

/**
 * Persists a recovered payload. The state + still-NULL guards make
 * the write idempotent against a concurrent recovery (admin manual
 * fix, second instance) — losing the race is a no-op (false).
 */
async function persistRecoveredRedemption(
  row: BackfillRow,
  redemption: { code: string | null; pin: string | null; url: string | null },
  now: number,
): Promise<boolean> {
  const updated = await db
    .update(orders)
    .set({
      // CF-25 / X-PRIV-03: same envelope as the primary fulfillment
      // write — encrypt code + PIN at rest, leave the URL plaintext.
      // No-op passthrough when LOOP_REDEEM_ENCRYPTION_KEY is unset.
      redeemCode: encryptRedeemField(redemption.code),
      redeemPin: encryptRedeemField(redemption.pin),
      redeemUrl: redemption.url,
      redemptionBackfillAttempts: row.attempts + 1,
      redemptionBackfillLastAttemptAt: new Date(now),
    })
    .where(
      and(
        eq(orders.id, row.id),
        eq(orders.state, 'fulfilled'),
        isNull(orders.redeemCode),
        isNull(orders.redeemPin),
        isNull(orders.redeemUrl),
      ),
    )
    .returning({ id: orders.id });
  if (updated.length === 0) return false;
  log.info(
    {
      orderId: row.id,
      ctxOrderId: row.ctxOrderId,
      attempt: row.attempts + 1,
      hasCode: redemption.code !== null,
      hasPin: redemption.pin !== null,
      hasUrl: redemption.url !== null,
    },
    'Redemption backfill recovered payload for fulfilled order',
  );
  return true;
}

/**
 * ADR 037 support action — one-shot redemption re-fetch for a
 * single order, through the SAME machinery as the sweeper
 * (`fetchRedemption` + the idempotent persist guards + the
 * attempts bookkeeping). Differences from a sweep tick, both
 * deliberate:
 *
 *   - no backoff gate and no attempts cap — the action exists
 *     precisely for orders the sweeper has exhausted (runbook:
 *     redemption-backfill-exhausted.md), and a human clicking it
 *     IS the rate limiter (plus the route's 10/min).
 *   - exhaustion paging still only fires when the bump crosses the
 *     cap exactly, so repeated admin re-drives past the cap don't
 *     re-page ops on every click.
 */
export type AdminRedemptionRefetchOutcome =
  | { kind: 'order_not_found' }
  | { kind: 'not_eligible'; reason: 'not_fulfilled' | 'no_ctx_order_id' | 'already_present' }
  | { kind: 'pool_unavailable' }
  | {
      kind: 'recovered' | 'still_empty';
      attempts: number;
      hasCode: boolean;
      hasPin: boolean;
      hasUrl: boolean;
    };

export async function refetchOrderRedemption(
  orderId: string,
  nowMs?: number,
): Promise<AdminRedemptionRefetchOutcome> {
  const now = nowMs ?? Date.now();
  const [row] = await db
    .select({
      id: orders.id,
      userId: orders.userId,
      merchantId: orders.merchantId,
      state: orders.state,
      ctxOrderId: orders.ctxOrderId,
      fulfilledAt: orders.fulfilledAt,
      redeemCode: orders.redeemCode,
      redeemPin: orders.redeemPin,
      redeemUrl: orders.redeemUrl,
      attempts: orders.redemptionBackfillAttempts,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (row === undefined) return { kind: 'order_not_found' };
  if (row.state !== 'fulfilled') return { kind: 'not_eligible', reason: 'not_fulfilled' };
  if (row.ctxOrderId === null) return { kind: 'not_eligible', reason: 'no_ctx_order_id' };
  if (row.redeemCode !== null || row.redeemPin !== null || row.redeemUrl !== null) {
    return { kind: 'not_eligible', reason: 'already_present' };
  }

  let redemption: { code: string | null; pin: string | null; url: string | null };
  try {
    redemption = await fetchRedemption(row.ctxOrderId);
  } catch (err) {
    if (err instanceof OperatorPoolUnavailableError) return { kind: 'pool_unavailable' };
    throw err;
  }

  const presence = {
    hasCode: redemption.code !== null,
    hasPin: redemption.pin !== null,
    hasUrl: redemption.url !== null,
  };
  if (presence.hasCode || presence.hasPin || presence.hasUrl) {
    const won = await persistRecoveredRedemption(row, redemption, now);
    // Losing the persist race means a concurrent writer landed a
    // payload — for the support user that's still "recovered".
    return { kind: 'recovered', attempts: won ? row.attempts + 1 : row.attempts, ...presence };
  }
  await recordEmptyAttempt(row, now);
  return { kind: 'still_empty', attempts: row.attempts + 1, ...presence };
}

interface BackfillRow {
  id: string;
  userId: string;
  merchantId: string;
  ctxOrderId: string | null;
  fulfilledAt: Date | null;
  attempts: number;
}

/**
 * Bumps the attempts counter + last-attempt timestamp after an empty
 * or failed re-fetch, and pages ops once when the bump crosses the
 * cap. The attempts guard on the UPDATE keeps a racing sweeper from
 * double-counting (and double-paging) the same attempt. `result` is
 * the sweep tick's tally; the ADR-037 one-shot admin path passes
 * none.
 */
async function recordEmptyAttempt(
  row: BackfillRow,
  now: number,
  result?: RedemptionBackfillTickResult,
): Promise<void> {
  const nextAttempts = row.attempts + 1;
  const updated = await db
    .update(orders)
    .set({
      redemptionBackfillAttempts: nextAttempts,
      redemptionBackfillLastAttemptAt: new Date(now),
    })
    .where(and(eq(orders.id, row.id), eq(orders.redemptionBackfillAttempts, row.attempts)))
    .returning({ id: orders.id });
  if (updated.length === 0) return; // raced — the other writer owns the bump
  // `===` not `>=`: the sweeper can only ever land exactly on the cap
  // (its SQL filter excludes rows at/past the cap), and the ADR-037
  // admin re-drive keeps bumping past it — re-paging ops on every
  // post-exhaustion click would be noise.
  if (nextAttempts === REDEMPTION_BACKFILL_MAX_ATTEMPTS) {
    if (result !== undefined) result.exhausted++;
    log.error(
      { orderId: row.id, ctxOrderId: row.ctxOrderId, attempts: nextAttempts },
      'Redemption backfill exhausted — order fulfilled but still has no redemption payload',
    );
    notifyRedemptionBackfillExhausted({
      orderId: row.id,
      userId: row.userId,
      merchantId: row.merchantId,
      ctxOrderId: row.ctxOrderId ?? 'unknown',
      attempts: nextAttempts,
      fulfilledAtMs: row.fulfilledAt?.getTime() ?? null,
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Interval loop ────────────────────────────────────────────────────────

let backfillTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic backfill sweeper. Gated at the caller
 * (`index.ts`) by `LOOP_WORKERS_ENABLED`, same as the procurement
 * worker it backstops. Per-tick errors are swallowed so a transient
 * CTX / DB blip doesn't kill the interval — the next tick retries.
 */
export function startRedemptionBackfill(args?: { intervalMs?: number }): void {
  if (backfillTimer !== null) return;
  const intervalMs = args?.intervalMs ?? REDEMPTION_BACKFILL_INTERVAL_MS;
  markWorkerStarted('redemption_backfill', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting redemption-backfill sweeper');
  const tick = async (): Promise<void> => {
    try {
      const r = await runRedemptionBackfillTick();
      if (r.picked > 0) {
        log.info(r, 'Redemption-backfill tick complete');
      }
      markWorkerTickSuccess('redemption_backfill');
    } catch (err) {
      markWorkerTickFailure('redemption_backfill', err);
      log.error({ err }, 'Redemption-backfill tick failed');
    }
  };
  void tick();
  backfillTimer = setInterval(() => void tick(), intervalMs);
  backfillTimer.unref();
}

export function stopRedemptionBackfill(): void {
  if (backfillTimer === null) return;
  clearInterval(backfillTimer);
  backfillTimer = null;
  markWorkerStopped('redemption_backfill');
  log.info('Redemption-backfill sweeper stopped');
}
