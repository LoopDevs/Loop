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
 * `markOrderFulfilled` doubles as the ADR 009 cashback capture: on
 * fulfillment it writes a `credit_transactions` row and bumps
 * `user_credits.balance_minor` by the pinned `user_cashback_minor`
 * amount, all inside one Drizzle transaction. If any step fails the
 * whole thing rolls back — the order stays in `procuring` and a
 * retry can re-run the whole transition cleanly.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, creditTransactions, userCredits } from '../db/schema.js';
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
    })
    .where(and(eq(orders.id, orderId), eq(orders.state, 'paid')))
    .returning();
  return rows[0] ?? null;
}

/**
 * Transition: `procuring` → `fulfilled`. Writes the cashback ledger
 * entries in the same txn (ADR 009 capture):
 *
 *   1. Update the order row: state, ctx_order_id, fulfilled_at.
 *   2. Insert a `credit_transactions` row (type='cashback',
 *      amount=+user_cashback_minor, reference_type='order',
 *      reference_id=<order-id>).
 *   3. Upsert the user's `user_credits` row for the order's currency,
 *      adding `user_cashback_minor` to the running balance.
 *
 * Returns the fulfilled order or null if the state wasn't `procuring`
 * (which makes the caller treat it as already-fulfilled + a no-op).
 * Zero-cashback orders still transition cleanly — the capture block
 * skips the ledger writes but the order still moves to `fulfilled`.
 */
export interface RedemptionPayload {
  code?: string | null;
  pin?: string | null;
  url?: string | null;
}

export async function markOrderFulfilled(
  orderId: string,
  opts: { ctxOrderId: string; redemption?: RedemptionPayload },
): Promise<Order | null> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(orders)
      .set({
        state: 'fulfilled',
        ctxOrderId: opts.ctxOrderId,
        fulfilledAt: new Date(),
        redeemCode: opts.redemption?.code ?? null,
        redeemPin: opts.redemption?.pin ?? null,
        redeemUrl: opts.redemption?.url ?? null,
      })
      .where(and(eq(orders.id, orderId), eq(orders.state, 'procuring')))
      .returning();
    const order = updated[0];
    if (order === undefined) return null;

    // Skip ledger writes when the pinned cashback amount is zero —
    // a cashback=0 row is not meaningful and would fail the
    // `credit_transactions_amount_sign` CHECK (which requires
    // cashback > 0).
    if (order.userCashbackMinor > 0n) {
      await tx.insert(creditTransactions).values({
        userId: order.userId,
        type: 'cashback',
        amountMinor: order.userCashbackMinor,
        currency: order.currency,
        referenceType: 'order',
        referenceId: order.id,
      });
      // Upsert the balance row: add cashback to existing, or create
      // a new per-currency row at the cashback amount. Concurrency-
      // safe via the unique index on (user_id, currency).
      await tx
        .insert(userCredits)
        .values({
          userId: order.userId,
          currency: order.currency,
          balanceMinor: order.userCashbackMinor,
        })
        .onConflictDoUpdate({
          target: [userCredits.userId, userCredits.currency],
          set: {
            balanceMinor: sql`${userCredits.balanceMinor} + ${order.userCashbackMinor}`,
            updatedAt: sql`NOW()`,
          },
        });
    }
    return order;
  });
}

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
