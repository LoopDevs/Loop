// redemption-backfill sweeper — ADR 052, S4-8, CF-14, CF-12, CF-25, ADR 037
import { db, withSingleFlight } from '../db/client.js';
import { logger } from '../logger.js';
import { notifyRedemptionBackfillExhausted } from '../discord.js';
import { CtxUnavailableError, CtxRateLimitedError } from '../ctx/api-fetch.js';
import { fetchRedemption } from './procurement-redemption.js';
import { encryptRedeemField } from './redeem-crypto.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSkippedLocked,
  markWorkerTickSuccess,
} from '../runtime-health.js';

const log = logger.child({ area: 'redemption-backfill' });

// 10th attempt lands ~17h post-fulfillment; beyond that it's a supplier-side issue, not a retry issue
export const REDEMPTION_BACKFILL_MAX_ATTEMPTS = 10;

const REDEMPTION_BACKFILL_BASE_DELAY_MS = 60_000;
const REDEMPTION_BACKFILL_MAX_DELAY_MS = 8 * 60 * 60 * 1000;

export const REDEMPTION_BACKFILL_INTERVAL_MS = 60_000;

const REDEMPTION_BACKFILL_BATCH_LIMIT = 20;

export function redemptionBackfillDelayMs(attempts: number): number {
  const exp = Math.min(attempts, 30); // 2^30 guard against overflow noise
  return Math.min(REDEMPTION_BACKFILL_BASE_DELAY_MS * 2 ** exp, REDEMPTION_BACKFILL_MAX_DELAY_MS);
}

export interface RedemptionBackfillTickResult {
  picked: number;
  notDueYet: number;
  recovered: number;
  stillEmpty: number;
  exhausted: number;
  errors: number;
  abortedCtxUnavailable: boolean;
  skippedLocked: boolean;
}

// CF-14: mutations are guarded compare-and-set, so concurrent sweepers won't double-write or clobber payloads
async function runRedemptionBackfillTickLocked(args?: {
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
    abortedCtxUnavailable: false,
    skippedLocked: false,
  };

  // Oldest fulfillment first to prevent starvation of long-stuck orders when batch limit bites
  const candidates = await db.collection('orders').findMany(
    {
      state: 'fulfilled',
      ctxOrderId: { $ne: null },
      redeemCode: null,
      redeemPin: null,
      redeemUrl: null,
      redemptionBackfillAttempts: { $lt: REDEMPTION_BACKFILL_MAX_ATTEMPTS },
    },
    { sort: [['fulfilledAt', 'asc']], limit: args?.limit ?? REDEMPTION_BACKFILL_BATCH_LIMIT },
  );
  const rows = candidates.map((o) => ({
    id: o.id,
    userId: o.userId,
    merchantId: o.merchantId,
    ctxOrderId: o.ctxOrderId,
    fulfilledAt: o.fulfilledAt,
    attempts: o.redemptionBackfillAttempts,
    lastAttemptAt: o.redemptionBackfillLastAttemptAt,
  }));
  result.picked = rows.length;

  for (const row of rows) {
    if (row.ctxOrderId === null) continue;

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
      if (err instanceof CtxUnavailableError || err instanceof CtxRateLimitedError) {
        // CF-12: abort without bumping attempts; this is our-side back-pressure, not evidence of missing payload
        log.warn(
          { orderId: row.id, rateLimited: err instanceof CtxRateLimitedError },
          'CTX unavailable / rate-limited — aborting redemption-backfill tick without burning attempts',
        );
        result.abortedCtxUnavailable = true;
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

function emptyBackfillTickResult(skippedLocked: boolean): RedemptionBackfillTickResult {
  return {
    picked: 0,
    notDueYet: 0,
    recovered: 0,
    stillEmpty: 0,
    exhausted: 0,
    errors: 0,
    abortedCtxUnavailable: false,
    skippedLocked,
  };
}

// INV-9: lease responsibility on caller; 240s fits 20 CTX re-fetches comfortably
const REDEMPTION_BACKFILL_TICK_LEASE_MS = 240_000;

const TICK_LEASE_TIMED_OUT = Symbol('redemption-backfill-tick-lease-timeout');

// S4-8: fleet-wide single-flight; only lock holder sweeps, others return immediately with skippedLocked
export async function runRedemptionBackfillTick(args?: {
  limit?: number;
  now?: number;
}): Promise<RedemptionBackfillTickResult> {
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const locked = await withSingleFlight('redemption-backfill', () =>
    Promise.race([
      runRedemptionBackfillTickLocked(args),
      new Promise<typeof TICK_LEASE_TIMED_OUT>((resolve) => {
        leaseTimer = setTimeout(
          () => resolve(TICK_LEASE_TIMED_OUT),
          REDEMPTION_BACKFILL_TICK_LEASE_MS,
        );
      }),
    ]),
  );
  if (leaseTimer !== undefined) clearTimeout(leaseTimer);
  if (!locked.ran) {
    return emptyBackfillTickResult(true);
  }
  if (locked.value === TICK_LEASE_TIMED_OUT) {
    log.error(
      { leaseMs: REDEMPTION_BACKFILL_TICK_LEASE_MS },
      'Redemption-backfill tick exceeded the lease deadline — releasing the lock so the fleet is not stalled; the in-flight sweep degrades to the pre-S4-8 per-machine posture',
    );
    return emptyBackfillTickResult(false);
  }
  return locked.value;
}

// Idempotent against concurrent recovery; losing the race is a no-op
async function persistRecoveredRedemption(
  row: BackfillRow,
  redemption: { code: string | null; pin: string | null; url: string | null },
  now: number,
): Promise<boolean> {
  const updated = await db.collection('orders').updateOne(
    { id: row.id, state: 'fulfilled', redeemCode: null, redeemPin: null, redeemUrl: null },
    {
      $set: {
        // CF-25 / X-PRIV-03: encrypt code + PIN at rest, leave URL plaintext
        redeemCode: encryptRedeemField(redemption.code),
        redeemPin: encryptRedeemField(redemption.pin),
        redeemUrl: redemption.url,
        redemptionBackfillAttempts: row.attempts + 1,
        redemptionBackfillLastAttemptAt: new Date(now),
      },
    },
  );
  if (updated === null) return false;
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

// ADR 037: one-shot re-fetch for exhausted orders; human click is the rate limiter
export type AdminRedemptionRefetchOutcome =
  | { kind: 'order_not_found' }
  | { kind: 'not_eligible'; reason: 'not_fulfilled' | 'no_ctx_order_id' | 'already_present' }
  | { kind: 'ctx_unavailable' }
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
  const order = await db.collection('orders').findOne({ id: orderId });
  if (order === null) return { kind: 'order_not_found' };
  if (order.state !== 'fulfilled') return { kind: 'not_eligible', reason: 'not_fulfilled' };
  if (order.ctxOrderId === null) return { kind: 'not_eligible', reason: 'no_ctx_order_id' };
  if (order.redeemCode !== null || order.redeemPin !== null || order.redeemUrl !== null) {
    return { kind: 'not_eligible', reason: 'already_present' };
  }
  const row: BackfillRow = {
    id: order.id,
    userId: order.userId,
    merchantId: order.merchantId,
    ctxOrderId: order.ctxOrderId,
    fulfilledAt: order.fulfilledAt,
    attempts: order.redemptionBackfillAttempts,
  };

  let redemption: { code: string | null; pin: string | null; url: string | null };
  try {
    redemption = await fetchRedemption(order.ctxOrderId);
  } catch (err) {
    if (err instanceof CtxUnavailableError) return { kind: 'ctx_unavailable' };
    throw err;
  }

  const presence = {
    hasCode: redemption.code !== null,
    hasPin: redemption.pin !== null,
    hasUrl: redemption.url !== null,
  };
  if (presence.hasCode || presence.hasPin || presence.hasUrl) {
    const won = await persistRecoveredRedemption(row, redemption, now);
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

// Attempts guard prevents double-counting/paging from racing sweepers
async function recordEmptyAttempt(
  row: BackfillRow,
  now: number,
  result?: RedemptionBackfillTickResult,
): Promise<void> {
  const nextAttempts = row.attempts + 1;
  const updated = await db.collection('orders').updateOne(
    { id: row.id, redemptionBackfillAttempts: row.attempts },
    {
      $set: {
        redemptionBackfillAttempts: nextAttempts,
        redemptionBackfillLastAttemptAt: new Date(now),
      },
    },
  );
  if (updated === null) return;
  // === not >=: sweeper lands exactly on cap; admin re-drive bumps past it without re-paging
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

let backfillTimer: ReturnType<typeof setInterval> | null = null;

// ADR 052: started unconditionally; per-tick errors swallowed so transient blips don't kill interval
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
      // S4-8: lock-skipped tick proves liveness but is recorded separately from a led tick
      if (r.skippedLocked) {
        markWorkerTickSkippedLocked('redemption_backfill');
      } else {
        markWorkerTickSuccess('redemption_backfill');
      }
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
