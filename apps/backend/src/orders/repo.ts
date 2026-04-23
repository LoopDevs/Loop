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
import { env } from '../env.js';
import {
  orders,
  merchantCashbackConfigs,
  userCredits,
  creditTransactions,
  type OrderPaymentMethod,
} from '../db/schema.js';

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

export interface CashbackSplit {
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  wholesaleMinor: bigint;
  userCashbackMinor: bigint;
  loopMarginMinor: bigint;
}

/**
 * Default split applied when no `merchant_cashback_configs` row
 * exists for a merchant. A2-203: the cashback / margin percentages
 * come from `DEFAULT_USER_CASHBACK_PCT_OF_CTX` + `DEFAULT_LOOP_MARGIN_PCT_OF_CTX`
 * (ADR 011), with zero on both as the out-of-the-box default. An ops
 * operator can flip in a non-zero default so newly-synced merchants
 * aren't accidentally zero-cashback between catalog-sync and the
 * first admin edit. Wholesale is residual (face - cashback - margin).
 */
function fallbackSplit(): Pick<
  CashbackSplit,
  'wholesalePct' | 'userCashbackPct' | 'loopMarginPct'
> {
  const userCashbackPct = env.DEFAULT_USER_CASHBACK_PCT_OF_CTX;
  const loopMarginPct = env.DEFAULT_LOOP_MARGIN_PCT_OF_CTX;
  const wholesale = 100 - Number.parseFloat(userCashbackPct) - Number.parseFloat(loopMarginPct);
  return {
    wholesalePct: wholesale.toFixed(2),
    userCashbackPct,
    loopMarginPct,
  };
}

/**
 * Multiplies a minor-unit amount by a NUMERIC(5,2)-typed pct string,
 * flooring. "10.00" → 1000 hundredths-of-a-percent, "7.5" → 750,
 * "7" → 700. Integer path exists for the edge case where postgres /
 * drizzle might hand us a bare integer; normal writes go through a
 * NUMERIC(5,2) column which round-trips as "X.YY".
 */
function applyPct(faceValueMinor: bigint, pctAsString: string): bigint {
  const dotIndex = pctAsString.indexOf('.');
  let hundredths: bigint;
  if (dotIndex === -1) {
    hundredths = BigInt(pctAsString) * 100n;
  } else {
    const integerPart = pctAsString.slice(0, dotIndex);
    const decimalPart = pctAsString
      .slice(dotIndex + 1)
      .padEnd(2, '0')
      .slice(0, 2);
    hundredths = BigInt(integerPart) * 100n + BigInt(decimalPart);
  }
  // value × pct/100 = value × hundredths / 10_000.
  return (faceValueMinor * hundredths) / 10_000n;
}

/**
 * Reads the current cashback config for a merchant and derives the
 * split for `faceValueMinor`. Falls back to a zero-split if the
 * merchant has no configured row (admin hasn't onboarded them).
 *
 * Returns numbers ready to INSERT straight into the `orders` row —
 * pcts as strings (matching the `numeric(5,2)` column type) and
 * amounts as BigInts.
 */
export async function computeCashbackSplit(args: {
  merchantId: string;
  faceValueMinor: bigint;
}): Promise<CashbackSplit> {
  const config = await db.query.merchantCashbackConfigs.findFirst({
    where: eq(merchantCashbackConfigs.merchantId, args.merchantId),
  });
  // Either there's no admin-set row or the row is explicitly inactive —
  // both collapse onto the env-driven fallback (A2-203).
  const split =
    config === undefined || config === null || !config.active
      ? fallbackSplit()
      : {
          wholesalePct: config.wholesalePct,
          userCashbackPct: config.userCashbackPct,
          loopMarginPct: config.loopMarginPct,
        };
  const userCashbackMinor = applyPct(args.faceValueMinor, split.userCashbackPct);
  const loopMarginMinor = applyPct(args.faceValueMinor, split.loopMarginPct);
  // Wholesale = face value - cashback - margin. Residual from the
  // flooring lands in wholesale; Loop overpays CTX by a few minor
  // units in the worst case, never the other way around.
  const wholesaleMinor = args.faceValueMinor - userCashbackMinor - loopMarginMinor;
  return {
    wholesalePct: split.wholesalePct,
    userCashbackPct: split.userCashbackPct,
    loopMarginPct: split.loopMarginPct,
    wholesaleMinor,
    userCashbackMinor,
    loopMarginMinor,
  };
}

/**
 * Generates a unique payment memo for an on-chain payment. Stellar
 * memos are `memo_text` (28 bytes max) or `memo_hash` (32 bytes).
 * Go with a 20-char base32-ish string — 100 bits of entropy, well
 * below the text limit, and case-sensitive so collisions across
 * orders are practically impossible.
 *
 * Pure helper so `createOrder` can call it without reaching into
 * node:crypto; exported for tests.
 */
export function generatePaymentMemo(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // 20 chars × 5 bits = 100 bits of entropy.
  let out = '';
  const buf = new Uint8Array(20);
  // crypto.getRandomValues is available in node's runtime globals.
  crypto.getRandomValues(buf);
  for (const byte of buf) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

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
  };

  // For credit-funded orders, do the insert + debit + state flip all
  // in one txn. Everything else (on-chain) just inserts and returns
  // pending_payment.
  if (args.paymentMethod !== 'credit') {
    const [row] = await db.insert(orders).values(baseValues).returning();
    if (row === undefined) {
      throw new Error('createOrder: no row returned');
    }
    return row;
  }

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
