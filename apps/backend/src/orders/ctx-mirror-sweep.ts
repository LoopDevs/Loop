/**
 * CTX mirror sweep (ADR 052) — the poll-side reconciler behind the
 * giftcard ws maintainer.
 *
 * The ws has no replay, so events that fire while Loop is
 * disconnected are gone; this sweep re-reads every non-terminal
 * mirror row (`unpaid` / `paid`) from CTX on an interval and applies
 * the same status mapping the ws path uses (`mirror-apply.ts`). It
 * also owns the two things CTX never pushes:
 *
 *   - **Payment expiry** — CTX leaves a never-paid card `unpaid`
 *     forever; once the CTX payment reads `expired` (or its
 *     `expires` + grace has lapsed), the local row flips `expired`.
 *   - **Economics retry** — a row whose operator read-back failed at
 *     create (`expected_commission_minor IS NULL`) gets the
 *     user-cashback / expected-commission derivation retried.
 *
 * Rows that never got a CTX card (create failed before
 * `recordCtxCreate`) are rejected after `ORPHAN_GRACE_MS`.
 *
 * Fleet-single-flighted via the same sha256 advisory-lock derivation
 * as the redemption backfill; every write is CAS-guarded in
 * `transitions.ts`, so duplicate runs are safe — the lock is a CTX
 * read-volume optimisation.
 */
import { withSingleFlight } from '../db/client.js';
import { logger } from '../logger.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSkippedLocked,
  markWorkerTickSuccess,
} from '../runtime-health.js';
import { listOpenMirrorOrders, recordOrderEconomics, type Order } from './repo.js';
import { markOrderExpired, markOrderRejected } from './transitions.js';
import { applyCtxCardStatus } from './mirror-apply.js';
import {
  deriveOrderEconomics,
  fetchCtxCardAsOperator,
  fetchCtxPayment,
  operatorProfitShareBp,
} from './ctx-order.js';
import { CtxRateLimitedError, CtxUnavailableError } from '../ctx/api-fetch.js';

const log = logger.child({ area: 'ctx-mirror-sweep' });

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 50;
/** CTX payment expiry is 10 min + 15 min grace; add slack on top. */
const EXPIRY_SLACK_MS = 5 * 60 * 1000;
/** A row with no CTX card after this long never got created upstream. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface MirrorSweepResult {
  picked: number;
  applied: number;
  expired: number;
  orphaned: number;
  errors: number;
  abortedCtxUnavailable: boolean;
  skippedLocked: boolean;
}

async function sweepOne(row: Order, now: number, r: MirrorSweepResult): Promise<void> {
  if (row.ctxOrderId === null) {
    if (now - row.createdAt.getTime() > ORPHAN_GRACE_MS) {
      await markOrderRejected(row.id, 'supplier create never completed');
      r.orphaned++;
    }
    return;
  }

  const card = await fetchCtxCardAsOperator(row.ctxOrderId);
  await applyCtxCardStatus(row, card);
  r.applied++;

  if (row.expectedCommissionMinor === null) {
    const profitShareBp = await operatorProfitShareBp();
    await recordOrderEconomics(row.id, deriveOrderEconomics(card, profitShareBp));
  }

  if (row.state === 'unpaid' && card.displayStatus === 'unpaid') {
    const paymentId = card.paymentId ?? row.ctxPaymentId;
    if (paymentId === null || paymentId === undefined) return;
    const payment = await fetchCtxPayment(paymentId);
    if (payment === null) return;
    const expiresMs = payment.expires !== undefined ? Date.parse(payment.expires) : Number.NaN;
    const windowLapsed = Number.isFinite(expiresMs) && now > expiresMs + EXPIRY_SLACK_MS;
    if (payment.status === 'expired' || windowLapsed) {
      const updated = await markOrderExpired(row.id);
      if (updated !== null) {
        r.expired++;
        log.info({ orderId: row.id }, 'Order mirror → expired (payment window lapsed)');
      }
    }
  }
}

export async function runMirrorSweepTick(nowMs?: number): Promise<MirrorSweepResult> {
  const r: MirrorSweepResult = {
    picked: 0,
    applied: 0,
    expired: 0,
    orphaned: 0,
    errors: 0,
    abortedCtxUnavailable: false,
    skippedLocked: false,
  };
  const locked = await withSingleFlight('ctx-mirror-sweep', async () => {
    const now = nowMs ?? Date.now();
    const rows = await listOpenMirrorOrders(SWEEP_BATCH);
    r.picked = rows.length;
    for (const row of rows) {
      try {
        await sweepOne(row, now, r);
      } catch (err) {
        if (err instanceof CtxUnavailableError || err instanceof CtxRateLimitedError) {
          // Upstream-wide outage / back-pressure — every subsequent row
          // hits the same wall; abort the tick and let the next one retry.
          r.abortedCtxUnavailable = true;
          log.warn(
            { orderId: row.id, rateLimited: err instanceof CtxRateLimitedError },
            'CTX unavailable — aborting mirror-sweep tick',
          );
          break;
        }
        r.errors++;
        log.warn({ orderId: row.id, err }, 'Mirror sweep row failed — retried next tick');
      }
    }
  });
  if (!locked.ran) {
    r.skippedLocked = true;
  }
  return r;
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startMirrorSweep(args?: { intervalMs?: number }): void {
  if (sweepTimer !== null) return;
  const intervalMs = args?.intervalMs ?? SWEEP_INTERVAL_MS;
  markWorkerStarted('ctx_mirror_sweep', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info({ intervalMs }, 'Starting CTX mirror sweep');
  const tick = async (): Promise<void> => {
    try {
      const r = await runMirrorSweepTick();
      if (r.picked > 0) log.info(r, 'Mirror sweep tick complete');
      if (r.skippedLocked) {
        markWorkerTickSkippedLocked('ctx_mirror_sweep');
      } else {
        markWorkerTickSuccess('ctx_mirror_sweep');
      }
    } catch (err) {
      log.error({ err }, 'Mirror sweep tick failed');
      markWorkerTickFailure('ctx_mirror_sweep', err);
    }
  };
  void tick();
  sweepTimer = setInterval(() => void tick(), intervalMs);
  sweepTimer.unref();
}

export function stopMirrorSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  markWorkerStopped('ctx_mirror_sweep');
}
