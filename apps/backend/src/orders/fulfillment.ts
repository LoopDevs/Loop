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
import { notifyPegBreakOnFulfillment } from '../discord.js';
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
  // A4-023 peg-break alert payload, captured inside the transaction
  // but emitted only after it commits — firing the Discord notify
  // from within the txn callback meant a rollback (e.g. a failed
  // pending_payouts insert) still alerted ops about ledger writes
  // that never landed.
  type PegBreakAlert = Parameters<typeof notifyPegBreakOnFulfillment>[0];
  const txnResult = await db.transaction<{
    order: Order;
    pegBreak: PegBreakAlert | null;
  } | null>(async (tx) => {
    let pegBreak: PegBreakAlert | null = null;
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
          // A4-023: peg break. Off-chain cashback already wrote
          // (above), but on-chain payout is skipped. Surface
          // beyond a log line — emit a Discord alert so ops can
          // manually compensate the on-chain side and restore
          // the 1:1 invariant. Capture the payload here; the log
          // + fire-and-forget notify happen after the transaction
          // resolves (see below) so a rollback can't alert on
          // ledger writes that never committed. A Discord blip
          // never blocks the order's transition.
          pegBreak = {
            orderId: order.id,
            userId: order.userId,
            chargeCurrency: order.chargeCurrency,
            userHomeCurrency: userRow.homeCurrency,
            cashbackMinor: order.userCashbackMinor.toString(),
          };
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
    return { order, pegBreak };
  });
  if (txnResult === null) return null;
  if (txnResult.pegBreak !== null) {
    log.warn(
      {
        orderId: txnResult.pegBreak.orderId,
        chargeCurrency: txnResult.pegBreak.chargeCurrency,
        userHomeCurrency: txnResult.pegBreak.userHomeCurrency,
      },
      'A4-023: order charge currency diverged from user home currency — on-chain payout skipped, peg break Discord notification sent',
    );
    notifyPegBreakOnFulfillment(txnResult.pegBreak);
  }
  return txnResult.order;
}
