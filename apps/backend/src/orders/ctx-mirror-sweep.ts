// CTX mirror sweep — ADR 052
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
import { db } from '../db/client.js';
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
const EXPIRY_SLACK_MS = 5 * 60 * 1000;
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

export type OrderResyncOutcome =
  | { kind: 'order_not_found' }
  | { kind: 'not_eligible'; reason: 'terminal_state' }
  | { kind: 'resynced'; state: Order['state'] };

export async function resyncOrderFromCtx(
  orderId: string,
  nowMs?: number,
): Promise<OrderResyncOutcome> {
  const order = await db.collection('orders').findOne({ id: orderId });
  if (order === null) return { kind: 'order_not_found' };
  if (order.state !== 'unpaid' && order.state !== 'paid') {
    return { kind: 'not_eligible', reason: 'terminal_state' };
  }

  const discard: MirrorSweepResult = {
    picked: 1,
    applied: 0,
    expired: 0,
    orphaned: 0,
    errors: 0,
    abortedCtxUnavailable: false,
    skippedLocked: false,
  };
  await sweepOne(order, nowMs ?? Date.now(), discard);

  const after = await db.collection('orders').findOne({ id: orderId });
  return { kind: 'resynced', state: after?.state ?? order.state };
}

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
