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
import { orders, creditTransactions, pendingPayouts, userCredits } from '../db/schema.js';
import { HOME_CURRENCIES, type HomeCurrency } from '../db/schema.js';
import { payoutAssetFor } from '../credits/payout-asset.js';
import { generatePayoutMemo } from '../credits/payout-builder.js';
import type { Order } from './repo.js';

/**
 * Transition: `pending_payment` → `paid`. Called by the payment
 * watcher once it sees a matching on-chain deposit. For credit-funded
 * orders the watcher transitions inside the same tx that debits the
 * user's balance (so a crashed watcher leaves the balance untouched);
 * that tx uses this helper's shape but inlines the debit alongside.
 *
 * **A4-110 (Critical) + ADR 036:** when the on-chain payment arrived
 * in a LOOP-asset (`paymentMethod = 'loop_asset'`), the user is
 * redeeming the cashback they previously accrued. The redemption
 * model (ADR 036, normative):
 *
 *   - Cashback fulfilment writes BOTH the off-chain `user_credits`
 *     liability mirror AND issues an on-chain LOOP-asset payout to
 *     the user's wallet. The on-chain half is the user's
 *     authoritative balance; both halves exist for reconciliation.
 *   - To redeem (gift card today, fiat-out later), the user's LOOP
 *     returns to the system, extinguishing BOTH halves: Loop debits
 *     `user_credits` and forwards the inbound LOOP from the deposit
 *     account back to the asset's ISSUER account — Stellar burns
 *     payments to the issuing account natively (ADR 036 open
 *     question 1: issuer-return, decided 2026-06-11).
 *
 * Before A4-110, the watcher accepted the inbound LOOP-asset and
 * flipped the order state but never debited `user_credits` — 2X
 * economic value for one cashback. Before ADR 036, the debit landed
 * but the received LOOP sat in the deposit account forever, so the
 * drift watcher's equation drifted monotonically upward with every
 * redemption.
 *
 * The transition runs inside a single Drizzle transaction:
 *   1. UPDATE orders SET state='paid' WHERE state='pending_payment'
 *   2. (loop_asset only) FOR UPDATE lock on user_credits
 *   3. (loop_asset only) INSERT credit_transactions
 *      type='spend' amount = -chargeMinor reference=(order, orderId)
 *   4. (loop_asset only) UPDATE user_credits SET balance -= chargeMinor
 *   5. (loop_asset only) INSERT pending_payouts kind='burn' —
 *      forwards the received LOOP (deposit account → issuer) via the
 *      existing payout worker. Same txn as the debit: a crash
 *      between steps leaves NEITHER half applied (the order stays
 *      pending_payment and the skip-table sweep retries).
 *
 * Other payment methods (`xlm`, `usdc`) are pre-cashback purchases —
 * they have no off-chain liability to extinguish, so the state flip
 * is the only side-effect. Credit-funded orders never reach this
 * path; they go through `repo-credit-order.ts:insertCreditOrderTxn`
 * which inlines the debit at order-creation time.
 */
export async function markOrderPaid(
  orderId: string,
  opts: {
    paymentReceivedAt?: Date;
    paymentReceivedHorizonId?: string | null;
    paymentReceivedTxHash?: string | null;
    paymentReceivedPayment?: unknown | null;
  } = {},
): Promise<Order | null> {
  const now = new Date();
  const paymentReceivedAt = opts.paymentReceivedAt ?? now;
  return db.transaction(async (tx) => {
    const [paid] = await tx
      .update(orders)
      .set({
        state: 'paid',
        paidAt: now,
        paymentReceivedAt,
        ...(opts.paymentReceivedHorizonId !== undefined
          ? { paymentReceivedHorizonId: opts.paymentReceivedHorizonId }
          : {}),
        ...(opts.paymentReceivedTxHash !== undefined
          ? { paymentReceivedTxHash: opts.paymentReceivedTxHash }
          : {}),
        ...(opts.paymentReceivedPayment !== undefined
          ? { paymentReceivedPayment: opts.paymentReceivedPayment }
          : {}),
      })
      .where(and(eq(orders.id, orderId), eq(orders.state, 'pending_payment')))
      .returning();
    if (paid === undefined) return null;

    // A4-110: extinguish the off-chain liability when the user's
    // own on-chain LOOP-asset funded the order. Other methods
    // (xlm/usdc) bypass this step.
    if (paid.paymentMethod === 'loop_asset' && paid.chargeMinor > 0n) {
      // Lock the (userId, currency) row FOR UPDATE so two concurrent
      // payments for the same user can't race the balance.
      const [existing] = await tx
        .select({ balanceMinor: userCredits.balanceMinor })
        .from(userCredits)
        .where(
          and(eq(userCredits.userId, paid.userId), eq(userCredits.currency, paid.chargeCurrency)),
        )
        .for('update');

      if (existing === undefined) {
        // Defence-in-depth: a user holding on-chain LOOP-asset MUST
        // have a matching off-chain `user_credits` row — the only
        // way to acquire LOOP on-chain is via cashback fulfilment
        // which writes both halves (fulfillment.ts:97-110 +
        // 149-160). A missing row at this point implies state
        // corruption (bad import, partial restore, manual SQL).
        // Throw so the txn rolls back and the order stays
        // pending_payment for ops to investigate.
        throw new LoopAssetMissingCreditRowError(paid.id, paid.userId, paid.chargeCurrency);
      }

      // Append-only ledger entry: type='spend' carries a NEGATIVE
      // amount per the credit_transactions_amount_sign CHECK
      // constraint. referenceType='order' / referenceId=orderId
      // pins the spend to its source so reconciliation can trace
      // the debit back to the user's loop_asset purchase.
      await tx.insert(creditTransactions).values({
        userId: paid.userId,
        type: 'spend',
        amountMinor: -paid.chargeMinor,
        currency: paid.chargeCurrency,
        referenceType: 'order',
        referenceId: paid.id,
      });

      // Decrement via SQL expression — the FOR UPDATE lock above
      // makes this safe; the DB expression is the ledger's own
      // source of truth. user_credits has a non_negative CHECK,
      // so a row that doesn't have enough balance to cover the
      // charge surfaces as a constraint violation. That should
      // never happen because the user couldn't have on-chain X
      // without the matching off-chain X (the only way to get
      // on-chain X is via cashback fulfilment which writes both
      // halves), but the CHECK is the defence-in-depth.
      await tx
        .update(userCredits)
        .set({ balanceMinor: sql`${userCredits.balanceMinor} - ${paid.chargeMinor}` })
        .where(
          and(eq(userCredits.userId, paid.userId), eq(userCredits.currency, paid.chargeCurrency)),
        );

      // ADR 036: extinguish the ON-CHAIN half too. The received LOOP
      // is sitting in the deposit/operator account; queue a
      // `kind='burn'` payout that forwards exactly the charged amount
      // to the asset's issuer account (Stellar burns payments to the
      // issuer natively). Processed by the existing payout worker —
      // memo-idempotent submit, classified retries (ADR 016).
      //
      // Asset resolution: the watcher only accepts a loop_asset
      // deposit whose asset currency matches `chargeCurrency`
      // (amount-sufficient.ts), so payoutAssetFor(chargeCurrency) is
      // exactly the asset that arrived. A missing issuer here means
      // the env was un-configured between deposit acceptance and
      // processing — throw so the whole txn (state flip + debit)
      // rolls back and the skip-table sweep retries once ops fixes
      // the config. Same crash-consistency as the debit: burn row
      // and debit land together or not at all.
      if (!(HOME_CURRENCIES as readonly string[]).includes(paid.chargeCurrency)) {
        throw new LoopAssetBurnUnavailableError(paid.id, paid.chargeCurrency, 'unknown_currency');
      }
      const burnAsset = payoutAssetFor(paid.chargeCurrency as HomeCurrency);
      if (burnAsset.issuer === null) {
        throw new LoopAssetBurnUnavailableError(paid.id, paid.chargeCurrency, 'issuer_unset');
      }
      // Belt-and-braces idempotency: the state-guarded UPDATE above
      // already makes this txn at-most-once per order, and the
      // partial unique index `pending_payouts_burn_order_unique`
      // fences a second burn row per order at the DB layer.
      await tx
        .insert(pendingPayouts)
        .values({
          userId: paid.userId,
          orderId: paid.id,
          kind: 'burn',
          assetCode: burnAsset.code,
          assetIssuer: burnAsset.issuer,
          toAddress: burnAsset.issuer,
          amountStroops: paid.chargeMinor * 100_000n,
          memoText: generatePayoutMemo(),
        })
        .onConflictDoNothing({
          target: pendingPayouts.orderId,
          // Index predicate of `pending_payouts_burn_order_unique` —
          // Postgres requires the ON CONFLICT target to match the
          // partial index, so the WHERE must travel with the target.
          where: sql`kind = 'burn'`,
        });
    }

    return paid;
  });
}

/**
 * ADR 036: thrown by `markOrderPaid` when a `loop_asset` redemption
 * cannot enqueue its issuer-return burn — either the order's charge
 * currency has no LOOP-asset mapping or the asset's issuer env var is
 * unset. Rolls the whole paid-transition back (debit included) so the
 * deposit parks in the watcher's skip table and is retried once ops
 * fixes the configuration.
 */
export class LoopAssetBurnUnavailableError extends Error {
  readonly orderId: string;
  readonly currency: string;
  readonly reason: 'unknown_currency' | 'issuer_unset';
  constructor(orderId: string, currency: string, reason: 'unknown_currency' | 'issuer_unset') {
    super(
      `Cannot enqueue issuer-return burn for order ${orderId}: ${reason} (currency=${currency}) — paid transition rolled back`,
    );
    this.name = 'LoopAssetBurnUnavailableError';
    this.orderId = orderId;
    this.currency = currency;
    this.reason = reason;
  }
}

/**
 * A4-110: thrown by `markOrderPaid` when a `loop_asset`-method
 * order arrives at the watcher but the user has no `user_credits`
 * row in the order's charge currency. Indicates state corruption
 * — a user holding on-chain LOOP without the matching off-chain
 * liability — and should never happen in normal operation. The
 * watcher catches and logs; the order stays in pending_payment
 * for ops to investigate via the admin user-detail surface.
 */
export class LoopAssetMissingCreditRowError extends Error {
  readonly orderId: string;
  readonly userId: string;
  readonly currency: string;
  constructor(orderId: string, userId: string, currency: string) {
    super(
      `LOOP-asset payment for order ${orderId} arrived but user ${userId} has no ${currency} user_credits row — state corruption`,
    );
    this.name = 'LoopAssetMissingCreditRowError';
    this.orderId = orderId;
    this.userId = userId;
    this.currency = currency;
  }
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
 * A4-101: revert `procuring` → `paid`. Used when a transient
 * pre-CTX-call failure (e.g. operator pool unavailable) means we
 * picked the row but never actually attempted the wholesale
 * purchase, so the order is safe to re-pick on the next tick.
 * Without this, the row sat in `procuring` until the stuck-sweep
 * marked it `failed` ~15 min later — a paid order silently
 * failing under a transient outage.
 *
 * Guarded on `state='procuring'` so we never roll back a row that
 * has already advanced past procurement.
 */
export async function revertOrderProcuringToPaid(orderId: string): Promise<Order | null> {
  const rows = await db
    .update(orders)
    .set({
      state: 'paid',
      ctxOperatorId: null,
      procuredAt: null,
    })
    .where(and(eq(orders.id, orderId), eq(orders.state, 'procuring')))
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
