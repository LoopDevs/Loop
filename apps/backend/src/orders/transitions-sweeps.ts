/**
 * Bulk-state-flipper sweeps for the order state machine
 * (ADR 010 / A2-621 / A2-708).
 *
 * Lifted out of `apps/backend/src/orders/transitions.ts` so the
 * two background sweeps live in their own focused module
 * separate from the per-order transition functions
 * (`markOrderPaid` / `markOrderProcuring` / `markOrderFulfilled`
 * / `markOrderFailed`) in the parent file:
 *
 *   - `sweepStuckProcurement(cutoff)` — flips procuring rows
 *     older than the cutoff to `failed` with reason
 *     `procurement_timeout` and emits an ops Discord embed
 *     per swept row (ambiguous outcome — manual reconcile
 *     against CTX before any user-facing refund).
 *   - `sweepExpiredOrders(cutoff)` — flips pending_payment
 *     rows older than the cutoff to `expired`.
 *
 * Re-exported from `transitions.ts` so the existing import
 * path (`'../orders/transitions.js'`) used by procurement.ts,
 * payments/watcher.ts, and the test suite (including its
 * dynamic `await import('../transitions.js')`) keeps working
 * unchanged.
 */
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { notifyStuckProcurementSwept } from '../discord.js';

/**
 * Bulk transition: any procuring rows older than `cutoff` →
 * `failed` (reason `procurement_timeout`). Called by the
 * procurement worker on a periodic tick — handles the case
 * where a worker crashed mid-procurement and the row would
 * otherwise sit stuck in `procuring` forever, blocking the
 * user from a retry and skewing the live-orders aggregate.
 *
 * Each swept row is observed by the user as a 'failed' order
 * — but the underlying ambiguity is "did CTX actually mint
 * the gift card before the worker crashed?". If yes, Loop
 * was charged but the user has no record. If no, Loop is
 * whole. Operators must reconcile against CTX's side
 * manually before issuing a refund. The per-row Discord embed
 * surfaces the drill-down inputs (order id, user id,
 * merchant, charge, operator id, stuck duration) so ops can
 * jump straight to the reconciliation query.
 *
 * Failure reason is set to `procurement_timeout` so a later audit
 * can differentiate genuine CTX rejections from crashed-worker
 * orphans. Returns the count swept.
 *
 * Safe against a live worker: the `state = 'procuring'` guard on the
 * UPDATE means a tick that reaches `markOrderFulfilled` after this
 * sweep sees the row already failed (null return → caller logs and
 * moves on, no ledger write).
 */
export async function sweepStuckProcurement(cutoff: Date): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(orders)
    .set({
      state: 'failed',
      failureReason: 'procurement_timeout',
      failedAt: now,
    })
    .where(and(eq(orders.state, 'procuring'), lt(orders.procuredAt, cutoff)))
    .returning({
      id: orders.id,
      userId: orders.userId,
      merchantId: orders.merchantId,
      chargeMinor: orders.chargeMinor,
      chargeCurrency: orders.chargeCurrency,
      ctxOperatorId: orders.ctxOperatorId,
      procuredAt: orders.procuredAt,
    });
  // A2-621: per-row Discord alert. The sweep's outcome is ambiguous
  // — we don't know whether CTX minted the gift card (and Loop was
  // charged) or the POST never landed. Ops needs to reconcile each
  // row manually before any user-facing refund. Running per-row
  // (not aggregated) is deliberate: a non-zero sweep is rare, and
  // when it happens each row needs its own drill-down, not a
  // "N swept" counter. Fire-and-forget AFTER the commit.
  for (const row of rows) {
    notifyStuckProcurementSwept({
      orderId: row.id,
      userId: row.userId,
      merchantId: row.merchantId,
      chargeMinor: row.chargeMinor.toString(),
      chargeCurrency: row.chargeCurrency,
      ctxOperatorId: row.ctxOperatorId,
      procuredAtMs: row.procuredAt?.getTime() ?? 0,
    });
  }
  return rows.length;
}

/**
 * Bulk transition: any pending_payment rows older than `cutoff` →
 * `expired`. Called by the payment watcher tick. A row that
 * never received its on-chain payment ages out and is closed off
 * so the live-orders aggregate doesn't grow forever.
 */
export async function sweepExpiredOrders(cutoff: Date): Promise<number> {
  const rows = await db
    .update(orders)
    .set({
      state: 'expired',
      failedAt: new Date(),
    })
    .where(and(eq(orders.state, 'pending_payment'), lt(orders.createdAt, cutoff)))
    .returning({ id: orders.id });
  return rows.length;
}
