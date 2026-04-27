/**
 * Cashback-split derivation + payment-memo generation
 * (ADR 011 / 015).
 *
 * Lifted out of `apps/backend/src/orders/repo.ts`. Three pure
 * helpers + the `CashbackSplit` interface that compose the
 * pricing / split half of `createOrder`:
 *
 *   - `applyPct` — `numeric(5,2)`-as-string × bigint minor-unit
 *     multiplier, flooring.
 *   - `fallbackSplit` — env-driven default applied when no
 *     `merchant_cashback_configs` row exists for a merchant.
 *   - `computeCashbackSplit` — reads the merchant\'s configured
 *     row (or the fallback), returns the (wholesalePct,
 *     userCashbackPct, loopMarginPct) percentages + the matching
 *     wholesaleMinor / userCashbackMinor / loopMarginMinor amounts.
 *   - `generatePaymentMemo` — 20-char base32-ish string, 100 bits
 *     of entropy, fits comfortably under Stellar\'s 28-byte memo_text
 *     limit. Used by every Stellar-paying flow (xlm / usdc /
 *     loop_asset payments).
 *
 * Pure functions only — none of these helpers care about the
 * order-creation transaction itself, just the inputs that flow
 * into it. That makes them straightforward to unit-test (#1206
 * snapshot of the audit suite).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { merchantCashbackConfigs } from '../db/schema.js';
import { env } from '../env.js';

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
