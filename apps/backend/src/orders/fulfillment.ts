/**
 * Order fulfillment transition (ADR 009 / 010 / 015).
 *
 * Lifted out of `./transitions.ts` so the cashback-capture +
 * payout-intent write doesn't share a file with the simple
 * state-only transitions (paid / procuring / failed). Fulfillment
 * is the one transition that fans out to four tables in a single
 * Drizzle transaction:
 *
 *   1. `orders`           — state → fulfilled, gift-card redemption fields
 *   2. `credit_transactions` — append cashback row (ADR 009)
 *   3. `user_credits`     — bump per-currency balance
 *   4. `pending_payouts`  — Stellar-side emission intent (ADR 015)
 *
 * Co-locating the ladder here keeps the multi-table semantics
 * (cashback capture co-fires with the on-chain payout intent inside
 * one txn — no orphaned payouts without a matching ledger row, no
 * ledger rows the payout worker never sees) readable as one slice.
 *
 * Re-exported from `./transitions.ts` so existing import sites
 * (`procurement.ts`, the admin compensation handler, the test
 * suite) keep resolving.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, creditTransactions, userCredits, users, pendingPayouts } from '../db/schema.js';
import { logger } from '../logger.js';
import { isHomeCurrency } from '@loop/shared';
import { buildPayoutIntent } from '../credits/payout-builder.js';
import type { Order } from './repo.js';

const log = logger.child({ area: 'order-transitions' });

export interface RedemptionPayload {
  code?: string | null;
  pin?: string | null;
  url?: string | null;
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
