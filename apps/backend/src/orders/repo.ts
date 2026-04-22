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
import { and, eq } from 'drizzle-orm';
import { FALLBACK_CASHBACK_SPLIT, splitCashbackFaceValue, type CashbackSplit } from '@loop/shared';
import { db } from '../db/client.js';
import { orders, merchantCashbackConfigs, type OrderPaymentMethod } from '../db/schema.js';

export type Order = typeof orders.$inferSelect;
export type { CashbackSplit };

/**
 * Reads the current cashback config for a merchant and derives the
 * split for `faceValueMinor`. Falls back to a zero-split (wholesale =
 * face value) if the merchant has no configured row or the row is
 * inactive — admin hasn't onboarded them yet.
 *
 * The math itself lives in `@loop/shared/cashback` so the web side
 * can show live previews ("you'll earn £0.42 on this £25 card")
 * without a round-trip. This wrapper owns the DB read + the fallback
 * policy; the split arithmetic is pure.
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
  if (config === undefined || config === null || !config.active) {
    return {
      ...FALLBACK_CASHBACK_SPLIT,
      wholesaleMinor: args.faceValueMinor,
    };
  }
  return splitCashbackFaceValue({
    faceValueMinor: args.faceValueMinor,
    wholesalePct: config.wholesalePct,
    userCashbackPct: config.userCashbackPct,
    loopMarginPct: config.loopMarginPct,
  });
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
 * Writes a new order row in `pending_payment` state with the cashback
 * split pinned. Returns the row so the handler can shape the payment
 * instructions back to the client.
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
  const [row] = await db
    .insert(orders)
    .values({
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
    })
    .returning();
  if (row === undefined) {
    throw new Error('createOrder: no row returned');
  }
  return row;
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
