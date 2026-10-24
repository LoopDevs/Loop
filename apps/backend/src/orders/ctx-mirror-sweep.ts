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
import {
  listOpenMirrorOrders,
  recordMirrorSynced,
  recordOrderEconomics,
  type Order,
} from './repo.js';
import { db } from '../db/client.js';
import { markOrderRejected } from './transitions.js';
import { applyCtxCardStatus } from './mirror-apply.js';
import {
  deriveOrderEconomics,
  fetchCtxCardAsOperator,
  listCtxCardsAsOperator,
  operatorProfitShareBp,
  type CtxGiftCard,
} from './ctx-order.js';
import { CtxRateLimitedError, CtxUnavailableError } from '../ctx/api-fetch.js';

const log = logger.child({ area: 'ctx-mirror-sweep' });

const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 500;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const CTX_PENDING_STATUSES = ['unpaid', 'paid'] as const;

export interface MirrorSweepResult {
  picked: number;
  applied: number;
  orphaned: number;
  errors: number;
  abortedCtxUnavailable: boolean;
  skippedLocked: boolean;
}

type PendingRow = Order & { ctxOrderId: string };

function isCtxUnavailable(err: unknown): boolean {
  return err instanceof CtxUnavailableError || err instanceof CtxRateLimitedError;
}

async function applyCard(
  row: Order,
  card: CtxGiftCard,
  now: number,
  r: MirrorSweepResult,
): Promise<void> {
  await applyCtxCardStatus(row, card);
  await recordMirrorSynced(row.id, new Date(now));
  r.applied++;

  if (row.expectedCommissionMinor === null) {
    const profitShareBp = await operatorProfitShareBp();
    await recordOrderEconomics(row.id, deriveOrderEconomics(card, profitShareBp));
  }
}

async function sweepOne(row: Order, now: number, r: MirrorSweepResult): Promise<void> {
  if (row.ctxOrderId === null) {
    if (now - row.createdAt.getTime() > ORPHAN_GRACE_MS) {
      await markOrderRejected(row.id, 'supplier create never completed');
      r.orphaned++;
    }
    return;
  }
  await applyCard(row, await fetchCtxCardAsOperator(row.ctxOrderId), now, r);
}

// One operator-scope list covers every row still pending at CTX; a row absent
// from it has reached a terminal state and is read individually to learn which.
async function sweepBatch(rows: Order[], now: number, r: MirrorSweepResult): Promise<void> {
  const pending: PendingRow[] = [];
  for (const row of rows) {
    if (row.ctxOrderId === null) {
      try {
        await sweepOne(row, now, r);
      } catch (err) {
        r.errors++;
        log.warn({ orderId: row.id, err }, 'Mirror sweep row failed — retried next tick');
      }
      continue;
    }
    pending.push({ ...row, ctxOrderId: row.ctxOrderId });
  }
  if (pending.length === 0) return;

  let pendingCards: Map<string, CtxGiftCard>;
  try {
    const cards = await listCtxCardsAsOperator(CTX_PENDING_STATUSES);
    pendingCards = new Map(cards.map((card) => [card.id, card]));
  } catch (err) {
    if (isCtxUnavailable(err)) {
      r.abortedCtxUnavailable = true;
      log.warn(
        { rateLimited: err instanceof CtxRateLimitedError },
        'CTX unavailable — aborting mirror-sweep tick',
      );
      return;
    }
    throw err;
  }

  for (const row of pending) {
    try {
      const card =
        pendingCards.get(row.ctxOrderId) ?? (await fetchCtxCardAsOperator(row.ctxOrderId));
      await applyCard(row, card, now, r);
    } catch (err) {
      if (isCtxUnavailable(err)) {
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
}

export async function runMirrorSweepTick(nowMs?: number): Promise<MirrorSweepResult> {
  const r: MirrorSweepResult = {
    picked: 0,
    applied: 0,
    orphaned: 0,
    errors: 0,
    abortedCtxUnavailable: false,
    skippedLocked: false,
  };
  const locked = await withSingleFlight('ctx-mirror-sweep', async () => {
    const now = nowMs ?? Date.now();
    const rows = await listOpenMirrorOrders(SWEEP_BATCH);
    r.picked = rows.length;
    await sweepBatch(rows, now, r);
  });
  if (!locked.ran) {
    r.skippedLocked = true;
  }
  return r;
}

let sweepTimer: NodeJS.Timeout | null = null;

export type OrderResyncOutcome =
  | { kind: 'order_not_found' }
  | { kind: 'resynced'; state: Order['state'] };

export async function resyncOrderFromCtx(
  orderId: string,
  nowMs?: number,
): Promise<OrderResyncOutcome> {
  const order = await db.collection('orders').findOne({ id: orderId });
  if (order === null) return { kind: 'order_not_found' };

  const discard: MirrorSweepResult = {
    picked: 1,
    applied: 0,
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
