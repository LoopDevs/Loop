/**
 * Order state-machine transitions (ADR 010 / ADR 009).
 *
 * These are the only writes that move an order between states. Each
 * transition uses an `UPDATE ... WHERE state = <expected>` + `RETURNING`
 * pattern so a misordered or duplicated transition (two payment-watcher
 * passes seeing the same tx, say) is a no-op — the second update
 * finds no row and returns null. Callers handle null as "already
 * transitioned" and move on.
 *
 * `markOrderFulfilled` (the cashback-capture + payout-intent
 * transition that fans out across `orders` + `credit_transactions`
 * + `user_credits` + `pending_payouts` in a single txn) lives in
 * `./fulfillment.ts` and is re-exported below so existing import
 * sites keep resolving.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { Order } from './repo.js';

/**
 * Transition: `pending_payment` → `paid`. Called by the payment
 * watcher once it sees a matching on-chain deposit. For credit-funded
 * orders the watcher transitions inside the same tx that debits the
 * user's balance (so a crashed watcher leaves the balance untouched);
 * that tx uses this helper's shape but inlines the debit alongside.
 */
export async function markOrderPaid(
  orderId: string,
  opts: { paymentReceivedAt?: Date } = {},
): Promise<Order | null> {
  const now = new Date();
  const rows = await db
    .update(orders)
    .set({
      state: 'paid',
      paidAt: now,
      paymentReceivedAt: opts.paymentReceivedAt ?? now,
    })
    .where(and(eq(orders.id, orderId), eq(orders.state, 'pending_payment')))
    .returning();
  return rows[0] ?? null;
}

/**
 * Transition: `paid` → `procuring`. Called when the procurement
 * worker picks the order up and is about to place the CTX wholesale
 * purchase. Records which operator account is attempting the call
 * (ADR 013 audit trail) so a later failure can be correlated.
 */
export async function markOrderProcuring(
  orderId: string,
  opts: { ctxOperatorId: string },
): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({
      state: 'procuring',
      ctxOperatorId: opts.ctxOperatorId,
      // Key the recovery sweep on this timestamp — `paid_at` would
      // include time spent waiting for the procurement worker's next
      // tick, which would pessimistically age the row.
      procuredAt: new Date(),
    })
    .where(and(eq(orders.id, orderId), eq(orders.state, 'paid')))
    .returning();
  return rows[0] ?? null;
}

// `markOrderFulfilled` (the cashback-capture + Stellar-payout-
// intent transition) lives in `./fulfillment.ts`. Re-exported
// here so existing import sites against `'./transitions.js'` keep
// resolving — the type also travels for callers that build the
// redemption payload.
export { markOrderFulfilled, type RedemptionPayload } from './fulfillment.js';

/**
 * Transition: any non-terminal state → `failed`. Called on a
 * procurement error that we've decided is non-retriable (CTX rejected
 * the card order, for example). Captures the reason string so an
 * operator looking at the admin panel can see why.
 *
 * Terminal states (`fulfilled`, `failed`, `expired`) are guarded by
 * the WHERE clause — double-failing an already-terminal order is a
 * no-op, not an error.
 */
export async function markOrderFailed(orderId: string, reason: string): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({
      state: 'failed',
      failureReason: reason,
      failedAt: new Date(),
    })
    .where(
      and(eq(orders.id, orderId), sql`${orders.state} IN ('pending_payment', 'paid', 'procuring')`),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Sweep: `pending_payment` orders older than `cutoff` → `expired`.
 * Called from a periodic job (not per-request). Returns the number
 * of rows swept so the caller can log the batch size.
 *
 * No per-order guarantee: an order paid right on the cutoff edge
 * could race with this sweep. The per-row WHERE on state handles
 * it — a payment watcher transition to `paid` beats this sweep
 * because both UPDATEs target the same row and Postgres serialises
 * them.
 */
/**
 * Sweep: `procuring` orders whose `procured_at` is older than `cutoff`
 * → `failed`. Called from a periodic recovery job for the case where
 * the procurement worker crashed between `markOrderProcuring` and
 * either `markOrderFulfilled` or `markOrderFailed`. Without this
 * sweep the order sits in `procuring` forever and the user never
 * gets a terminal state.
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
// `sweepStuckProcurement` (A2-621 ambiguous-outcome ops alert
// included) and `sweepExpiredOrders` live in
// `./transitions-sweeps.ts` — they're bulk-state-flipper
// background sweeps, separate from the per-order transitions
// above. Re-exported below so `'../orders/transitions.js'`
// keeps resolving for procurement.ts, payments/watcher.ts, and
// the test suite (including its dynamic
// `await import('../transitions.js')`).
export { sweepStuckProcurement, sweepExpiredOrders } from './transitions-sweeps.js';
