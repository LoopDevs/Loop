/**
 * Cashback-split math (ADR 011 / 015).
 *
 * Pure functions shared between backend order creation
 * (`apps/backend/src/orders/repo.ts`) and web cashback previews
 * ("you'll earn £0.42 on this £25 card"). No DB access, no I/O —
 * callers are responsible for fetching the merchant's
 * `merchantCashbackConfigs` row and handing us the three percentages.
 *
 * All amounts are minor units as `bigint` (pence / cents) so we can
 * compose with order rows directly. All percentages are strings in
 * the `numeric(5,2)` Postgres shape ("18.00", "7.5", "100") — matches
 * what round-trips from the db so both sides avoid a parse step.
 *
 * Flooring: we floor every per-party amount. The residual always
 * lands in `wholesaleMinor` so Loop over-pays the supplier by a few
 * minor units in the worst case, never the other way around. That's
 * a deliberate choice documented in ADR 015 — better to eat a pence
 * than short-pay CTX or the user.
 */

/**
 * Multiply a minor-unit amount by a pct-as-string (numeric(5,2)),
 * flooring. "10.00" → 10%, "7.5" → 7.5%, "7" → 7%.
 *
 * Works on BigInts end-to-end: for a £100 face value (faceMinor = 10000n)
 * at "18.00", returns 1800n (£18.00). No Number coercion anywhere.
 */
export function applyCashbackPct(faceValueMinor: bigint, pctAsString: string): bigint {
  const dotIndex = pctAsString.indexOf('.');
  let hundredths: bigint;
  if (dotIndex === -1) {
    // Integer path — normally only hit if a caller hands us a bare
    // integer that bypassed the numeric(5,2) round-trip. Still valid.
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

export interface CashbackSplit {
  /** Pct-as-string, echoed from the input so callers can persist the config snapshot. */
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  /** Minor-unit shares; wholesaleMinor absorbs flooring residual. */
  wholesaleMinor: bigint;
  userCashbackMinor: bigint;
  loopMarginMinor: bigint;
}

/**
 * Split a face value across the three parties using the merchant's
 * pct config. `userCashbackMinor` and `loopMarginMinor` are computed
 * by `applyCashbackPct` (floored); `wholesaleMinor` is whatever's
 * left so the three sum exactly to `faceValueMinor`.
 *
 * The split is deterministic — same inputs always produce the same
 * output. No randomness, no time-dependence. That's the contract the
 * order-creation path (which snapshots these values into the row at
 * insert-time) relies on.
 */
export function splitCashbackFaceValue(args: {
  faceValueMinor: bigint;
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
}): CashbackSplit {
  const userCashbackMinor = applyCashbackPct(args.faceValueMinor, args.userCashbackPct);
  const loopMarginMinor = applyCashbackPct(args.faceValueMinor, args.loopMarginPct);
  const wholesaleMinor = args.faceValueMinor - userCashbackMinor - loopMarginMinor;
  return {
    wholesalePct: args.wholesalePct,
    userCashbackPct: args.userCashbackPct,
    loopMarginPct: args.loopMarginPct,
    wholesaleMinor,
    userCashbackMinor,
    loopMarginMinor,
  };
}

/**
 * Zero-cashback fallback used when a merchant has no configured split.
 * wholesalePct is "100.00" and the other two are "0.00" — Loop pays
 * CTX full-price for the card, takes nothing, gives nothing back.
 * Admin must configure the merchant before any margin or cashback can
 * accrue. Matches the FALLBACK_SPLIT the backend used pre-extraction.
 */
export const FALLBACK_CASHBACK_SPLIT: Readonly<CashbackSplit> = Object.freeze({
  wholesalePct: '100.00',
  userCashbackPct: '0.00',
  loopMarginPct: '0.00',
  wholesaleMinor: 0n,
  userCashbackMinor: 0n,
  loopMarginMinor: 0n,
});
