/**
 * Procurement worker (ADR 010).
 *
 * Picks up `paid` orders, places the wholesale gift-card purchase
 * against CTX using the operator pool (ADR 013), and transitions
 * through `procuring` → `fulfilled` (or `failed`). Each successful
 * fulfillment triggers the ADR 009 cashback capture inside
 * `markOrderFulfilled`.
 *
 * Run model: a periodic job picks up to N paid orders per tick. No
 * per-order locking — the `markOrderProcuring` state-guarded UPDATE
 * is the lock. Two workers racing on the same order: whichever wins
 * the UPDATE proceeds; the loser gets null and moves on to the next.
 *
 * The per-order ladder (mark-procuring → rail decision → CTX call
 * → redemption → mark-fulfilled + Discord fanout) lives in
 * `./procure-one.ts`. This file is the batch driver.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { procureOne } from './procure-one.js';

export interface ProcurementTickResult {
  picked: number;
  fulfilled: number;
  failed: number;
  skipped: number;
}

// `procureOne` (the per-order procurement attempt) lives in
// `./procure-one.ts`. Re-exported here so existing test imports
// against `'../orders/procurement.js'` keep resolving.
export { procureOne } from './procure-one.js';

// Procurement asset-picker (USDC vs XLM rail decision + below-floor
// alert throttle) lives in `./procurement-asset-picker.ts`.
// Re-exported here so `__tests__/procurement.test.ts` keeps
// importing from the historical path without re-targeting.
export {
  pickProcurementAsset,
  __resetBelowFloorAlertForTests,
} from './procurement-asset-picker.js';

/**
 * Processes up to `limit` paid orders. Oldest-first (by `paid_at`)
 * so an incident-backlog drains FIFO rather than starving early
 * orders behind newer ones.
 */
export async function runProcurementTick(
  args: { limit?: number } = {},
): Promise<ProcurementTickResult> {
  const limit = args.limit ?? 10;
  const paidOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.state, 'paid'))
    .orderBy(asc(orders.paidAt))
    .limit(limit);

  const result: ProcurementTickResult = {
    picked: paidOrders.length,
    fulfilled: 0,
    failed: 0,
    skipped: 0,
  };

  for (const order of paidOrders) {
    const outcome = await procureOne(order);
    result[outcome]++;
  }
  return result;
}

// `startProcurementWorker` / `stopProcurementWorker` (the
// periodic-loop bootstrap) and the `PROCUREMENT_TIMEOUT_MS` /
// `SWEEP_INTERVAL_MS` constants live in `./procurement-worker.ts`.
// Re-exported below so `'../orders/procurement.js'` keeps
// resolving for `index.ts` and the test suite.
export { startProcurementWorker, stopProcurementWorker } from './procurement-worker.js';
