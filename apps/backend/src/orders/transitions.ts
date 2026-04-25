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
import { orders, creditTransactions, userCredits, users, pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';
import { isHomeCurrency } from '@loop/shared';
import { buildPayoutIntent } from '../credits/payout-builder.js';
import { notifyStuckProcurementSwept } from '../discord.js';
import type { Order } from './repo.js';

const log = logger.child({ area: 'order-transitions' });

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
      // ADR 015 — write the ledger in the user's home currency
      // (charge_currency), not the catalog currency (currency).
      // For same-currency orders this is a no-op (they're equal);
      // for cross-FX orders this is the correct denomination since
      // user_cashback_minor is now computed from chargeMinor.
      await tx.insert(creditTransactions).values({
        userId: order.userId,
        type: 'cashback',
        amountMinor: order.userCashbackMinor,
        currency: order.chargeCurrency,
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
          currency: order.chargeCurrency,
          balanceMinor: order.userCashbackMinor,
        })
        .onConflictDoUpdate({
          target: [userCredits.userId, userCredits.currency],
          set: {
            balanceMinor: sql`${userCredits.balanceMinor} + ${order.userCashbackMinor}`,
            updatedAt: sql`NOW()`,
          },
        });

      // ADR 015 — write a pending payout row for the Stellar-side
      // emission, if the user has a linked wallet + a configured
      // LOOP issuer for their home currency. The SDK submit worker
      // reads pending rows and signs + submits each one. Building
      // + inserting inside the same transaction as the ledger write
      // means a crash mid-fulfillment either records both or
      // neither — no orphaned payouts without a matching ledger
      // entry, no ledger entries the payout worker never sees.
      const [userRow] = await tx
        .select({
          stellarAddress: users.stellarAddress,
          homeCurrency: users.homeCurrency,
        })
        .from(users)
        .where(eq(users.id, order.userId));
      if (userRow !== undefined && isHomeCurrency(userRow.homeCurrency)) {
        // order.chargeCurrency pins the ledger currency. An audit
        // warning when it doesn't match the user's home currency —
        // shouldn't happen (loop-handler pins both to home currency
        // at order creation), but would indicate support-mediated
        // home-currency change after an order was placed.
        if (order.chargeCurrency !== userRow.homeCurrency) {
          log.warn(
            {
              orderId: order.id,
              chargeCurrency: order.chargeCurrency,
              userHomeCurrency: userRow.homeCurrency,
            },
            'Order charge currency diverged from user home currency — on-chain payout skipped',
          );
        } else {
          const decision = buildPayoutIntent({
            stellarAddress: userRow.stellarAddress,
            homeCurrency: userRow.homeCurrency,
            userCashbackMinor: order.userCashbackMinor,
          });
          if (decision.kind === 'pay') {
            await tx
              .insert(pendingPayouts)
              .values({
                userId: order.userId,
                orderId: order.id,
                assetCode: decision.intent.assetCode,
                assetIssuer: decision.intent.assetIssuer,
                toAddress: decision.intent.to,
                amountStroops: decision.intent.amountStroops,
                memoText: decision.intent.memoText,
              })
              .onConflictDoNothing({ target: pendingPayouts.orderId });
          } else {
            log.info(
              { orderId: order.id, reason: decision.reason },
              'Skipping on-chain cashback payout',
            );
          }
        }
      }
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
