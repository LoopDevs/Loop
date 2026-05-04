/**
 * Loop-order repository (ADR 010).
 *
 * Owns writes against the `orders` table. The key invariant: when an
 * order is created the three cashback percentages are SNAPSHOTTED
 * from `merchant_cashback_configs` into the order row. A later admin
 * edit of the merchant's config does not rewrite this order.
 *
 * Derived minor-unit amounts (wholesale / user cashback / Loop margin)
 * are computed on creation from the pinned pcts × face value, also
 * stored on the row, so the eventual ledger write on fulfillment
 * (ADR 009) reads numbers that can't silently drift.
 *
 * Integer-arithmetic only: face value is already minor units; we
 * multiply by the percentage × 100 (two decimals → hundredths-of-a-
 * percent as an int) and divide, flooring.
 *
 * A4-018: rounding-residual policy. `cashback-split.ts` computes
 * `userCashbackMinor` (floor) and `loopMarginMinor` (floor) from
 * the configured percentages, then derives
 * `wholesaleMinor = faceValue - userCashback - loopMargin`. So
 * the residual after both floors lands in `wholesaleMinor` —
 * what Loop pays CTX. Loop's margin is exact; the user's cashback
 * is exact-floored; Loop "absorbs" the 0–3 minor-unit residual on
 * the wholesale side. This is the conservative direction (the
 * user is never short, Loop never over-quotes its own margin).
 * The on-chain settlement to CTX is the one that runs slightly
 * higher — operationally a non-issue at single-order granularity.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { orders, type OrderPaymentMethod } from '../db/schema.js';
import { computeCashbackSplit, generatePaymentMemo } from './cashback-split.js';
import { InsufficientCreditError } from './repo-errors.js';
import { insertCreditOrderTxn } from './repo-credit-order.js';

export type Order = typeof orders.$inferSelect;

// `InsufficientCreditError` lives in `./repo-errors.ts` so both this
// file and the credit-order txn helper can share a single instance
// without a circular import. Re-exported here so existing import
// sites (handlers + tests) keep resolving.
export { InsufficientCreditError } from './repo-errors.js';

// Cashback-split derivation + payment-memo generation lives in
// `./cashback-split.ts`. Re-exported here so existing import sites
// (orders/handler.ts + tests) keep working without re-targeting.
export { type CashbackSplit, computeCashbackSplit, generatePaymentMemo } from './cashback-split.js';

// A2-2003 idempotency primitives (error type + pre-write lookup +
// post-insert conflict resolver) live in `./repo-idempotency.ts`.
// Re-exported here so the existing import paths used by
// loop-handler.ts and the test suite keep resolving. Imported back
// for use inside `createOrder`'s catch arm below.
import {
  IdempotentOrderConflictError,
  findOrderByIdempotencyKey,
  maybeFetchIdempotentConflict,
} from './repo-idempotency.js';
export { IdempotentOrderConflictError, findOrderByIdempotencyKey };

export interface CreateOrderArgs {
  userId: string;
  merchantId: string;
  faceValueMinor: bigint;
  currency: string;
  paymentMethod: OrderPaymentMethod;
  /**
   * What the user was charged, in their home currency at order
   * creation (ADR 015). Defaults to `{ faceValueMinor, currency }`
   * — correct when the user's home currency matches the gift-card
   * currency, which is every order until the FX-pin slice lands.
   */
  chargeMinor?: bigint;
  chargeCurrency?: string;
  /** Override for tests; production leaves this undefined and the repo generates it. */
  paymentMemo?: string;
  /**
   * A2-2003: optional client-supplied idempotency key. When set, the
   * row carries it and the (user_id, key) partial unique index in
   * `orders_user_idempotency_unique` rejects a second insert with the
   * same pair. The handler converts that violation into a replay of
   * the already-created order's response.
   */
  idempotencyKey?: string;
}

/**
 * Writes a new order row. For on-chain payment methods the row lands
 * in `pending_payment` awaiting a watcher-observed deposit. For
 * credit-funded orders (A2-601 fix) this function additionally debits
 * the user's `user_credits` balance and transitions the order to
 * `paid` inside the same transaction — so a caller who observes a
 * returned order is guaranteed either:
 *
 *   - `state='pending_payment'` with no ledger side-effect (on-chain
 *     orders, awaiting external payment), or
 *   - `state='paid'` with a matching `type='spend'` ledger row and a
 *     debited balance (credit orders, fully settled).
 *
 * There is no intermediate state where the order is created but the
 * credit isn't yet debited, which means procurement can treat every
 * `paid` credit order the same as a `paid` on-chain order.
 *
 * If the user's live balance (re-read `FOR UPDATE` inside the txn)
 * is below `chargeMinor`, the function throws
 * `InsufficientCreditError` and the txn rolls back — no order row
 * is persisted. The caller's prior `hasSufficientCredit` fast-path
 * is a UX check, not a guard; a concurrent admin adjustment could
 * drain the balance between check and insert.
 *
 * Payment memo is generated for on-chain methods (xlm / usdc) and
 * left null for `credit` — a balance debit doesn't cross the chain.
 */
export async function createOrder(args: CreateOrderArgs): Promise<Order> {
  // ADR 015 — pin the split in the user's home-currency terms
  // (chargeMinor), so user_cashback_minor + loop_margin_minor land
  // in the currency the ledger + balance are denominated in. The
  // `wholesale_minor` field becomes an accounting approximation of
  // what Loop pays CTX, derived at the same FX rate (via
  // chargeMinor) — actual CTX settlement uses the catalog-currency
  // face value at procurement time.
  const requestedChargeMinor = args.chargeMinor ?? args.faceValueMinor;
  const chargeCurrency = args.chargeCurrency ?? args.currency;
  const split = await computeCashbackSplit({
    merchantId: args.merchantId,
    faceValueMinor: requestedChargeMinor,
  });

  // Tranche 1 (MVP) discount mode. When `LOOP_PHASE_1_ONLY=true`,
  // the cashback portion of the configured split is applied as
  // an INSTANT DISCOUNT at order-creation time rather than emitted
  // as a post-purchase Stellar payout. Math:
  //
  //   - Pre-discount charge = requestedChargeMinor
  //   - Discount delivered  = split.userCashbackMinor
  //   - User actually pays  = requestedChargeMinor − discount
  //   - userCashbackMinor stored = 0 (nothing to emit later)
  //   - wholesaleMinor + loopMarginMinor unchanged (Loop still pays
  //     CTX the same wholesale; Loop's margin is the same)
  //
  // Fulfillment.ts already gates `pending_payouts` insertion on
  // `userCashbackMinor > 0n`, so zeroing it here also turns off the
  // on-chain emission for free. Discount badges on merchant cards
  // (the Tranche 1 user proposition) are driven by
  // `merchant_cashback_configs.user_cashback_pct` and stay accurate
  // because the pct itself isn't changing — only the delivery
  // channel is.
  //
  // Tranche 2 flips `LOOP_PHASE_1_ONLY=false` and the cashback
  // becomes a Stellar payout again. No schema change.
  const tranche1Discount = env.LOOP_PHASE_1_ONLY ? split.userCashbackMinor : 0n;
  const chargeMinor = requestedChargeMinor - tranche1Discount;
  const userCashbackMinorOnRow = env.LOOP_PHASE_1_ONLY ? 0n : split.userCashbackMinor;
  const userCashbackPctOnRow = env.LOOP_PHASE_1_ONLY ? '0.00' : split.userCashbackPct;

  const paymentMemo =
    args.paymentMemo ?? (args.paymentMethod === 'credit' ? null : generatePaymentMemo());

  const baseValues = {
    userId: args.userId,
    merchantId: args.merchantId,
    faceValueMinor: args.faceValueMinor,
    currency: args.currency,
    chargeMinor,
    chargeCurrency,
    paymentMethod: args.paymentMethod,
    paymentMemo,
    wholesalePct: split.wholesalePct,
    userCashbackPct: userCashbackPctOnRow,
    loopMarginPct: split.loopMarginPct,
    wholesaleMinor: split.wholesaleMinor,
    userCashbackMinor: userCashbackMinorOnRow,
    loopMarginMinor: split.loopMarginMinor,
    idempotencyKey: args.idempotencyKey ?? null,
  };

  // For credit-funded orders, do the insert + debit + state flip all
  // in one txn. Everything else (on-chain) just inserts and returns
  // pending_payment.
  if (args.paymentMethod !== 'credit') {
    try {
      const [row] = await db.insert(orders).values(baseValues).returning();
      if (row === undefined) {
        throw new Error('createOrder: no row returned');
      }
      return row;
    } catch (err) {
      // A2-2003: a concurrent caller raced us to the same
      // (userId, idempotencyKey) pair. Re-fetch the prior order so
      // the handler can replay its response.
      const conflict = await maybeFetchIdempotentConflict(args, err);
      if (conflict !== null) throw new IdempotentOrderConflictError(conflict);
      throw err;
    }
  }

  try {
    return await insertCreditOrderTxn({ ...baseValues, paymentMethod: 'credit', paymentMemo });
  } catch (err) {
    if (err instanceof InsufficientCreditError) throw err;
    // A2-2003: a concurrent caller raced us to the same
    // (userId, idempotencyKey) pair. The whole txn rolled back, so
    // no debit / order row landed for this attempt. Re-fetch the
    // prior order and surface as IdempotentOrderConflictError so the
    // handler can replay its response.
    const conflict = await maybeFetchIdempotentConflict(args, err);
    if (conflict !== null) throw new IdempotentOrderConflictError(conflict);
    throw err;
  }
}

/**
 * Looks up the unique `pending_payment` order for a given payment
 * memo. Used by the payment watcher to route an incoming on-chain
 * deposit to the order it funds.
 *
 * Returns null when no matching live order exists — either the
 * memo is unknown (wrong tx, replayed scan) or the order has
 * already transitioned to `paid` or past. Both cases are no-ops
 * for the watcher.
 */
export async function findPendingOrderByMemo(memo: string): Promise<Order | null> {
  const row = await db.query.orders.findFirst({
    where: and(eq(orders.paymentMemo, memo), eq(orders.state, 'pending_payment')),
  });
  return row ?? null;
}
