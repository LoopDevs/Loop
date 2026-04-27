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
 * percent as an int) and divide, flooring. The rounding residual
 * lands in Loop's margin — errs toward Loop, never toward a user
 * being owed an extra penny we haven't reserved.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders, userCredits, creditTransactions, type OrderPaymentMethod } from '../db/schema.js';
import { computeCashbackSplit, generatePaymentMemo } from './cashback-split.js';

export type Order = typeof orders.$inferSelect;

/**
 * Raised by `createOrder` when a credit-funded order cannot be paid
 * because the user's live balance (re-read FOR UPDATE inside the
 * same txn that would debit it) is below the charge amount.
 *
 * The caller's prior `hasSufficientCredit` fast-path check is a UX
 * nicety, not a guard — a concurrent admin adjustment or a
 * just-captured spend between the check and the insert can leave
 * the balance insufficient. In that case the txn aborts and nothing
 * is written; callers translate this to a 400.
 */
export class InsufficientCreditError extends Error {
  constructor() {
    super('Loop credit balance is below the order amount');
    this.name = 'InsufficientCreditError';
  }
}

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
  const chargeMinor = args.chargeMinor ?? args.faceValueMinor;
  const chargeCurrency = args.chargeCurrency ?? args.currency;
  const split = await computeCashbackSplit({
    merchantId: args.merchantId,
    faceValueMinor: chargeMinor,
  });
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
    userCashbackPct: split.userCashbackPct,
    loopMarginPct: split.loopMarginPct,
    wholesaleMinor: split.wholesaleMinor,
    userCashbackMinor: split.userCashbackMinor,
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
    return await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(orders).values(baseValues).returning();
      if (inserted === undefined) {
        throw new Error('createOrder: no row returned');
      }

      // Re-read balance under a FOR UPDATE lock. A concurrent admin
      // adjustment or another credit order against the same
      // (user, currency) row serialises through here. This is the
      // guard — the earlier `hasSufficientCredit` at the handler is a
      // UX fast-path that can be racy.
      const fresh = await tx
        .select({ balanceMinor: userCredits.balanceMinor })
        .from(userCredits)
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, chargeCurrency)))
        .for('update');

      const balance = fresh[0]?.balanceMinor ?? 0n;
      if (balance < chargeMinor) {
        throw new InsufficientCreditError();
      }

      // Ledger: type='spend' carries a NEGATIVE amount per schema CHECK
      // (`spend`/`withdrawal` amount<0). Reference this order so
      // reconciliation can trace the debit back to its cause.
      await tx.insert(creditTransactions).values({
        userId: args.userId,
        type: 'spend',
        amountMinor: -chargeMinor,
        currency: chargeCurrency,
        referenceType: 'order',
        referenceId: inserted.id,
      });

      // Balance: subtract via SQL expression rather than JS arithmetic
      // on the freshly-read value, since the lock already serialises
      // us and the DB expression is the ledger's own source of truth.
      await tx
        .update(userCredits)
        .set({ balanceMinor: sql`${userCredits.balanceMinor} - ${chargeMinor}` })
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, chargeCurrency)));

      // Transition to paid. Mirrors `markOrderPaid`'s shape but stays
      // within this txn so the debit + state flip commit together.
      const now = new Date();
      const [paid] = await tx
        .update(orders)
        .set({
          state: 'paid',
          paidAt: now,
          paymentReceivedAt: now,
        })
        .where(and(eq(orders.id, inserted.id), eq(orders.state, 'pending_payment')))
        .returning();
      if (paid === undefined) {
        // Unreachable — the row was just inserted above in the same
        // txn; nothing else can have transitioned it. Throw loudly so
        // a future refactor that breaks this invariant is obvious.
        throw new Error('createOrder: credit-order paid-transition lost race with self');
      }
      return paid;
    });
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
