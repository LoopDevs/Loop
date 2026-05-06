/**
 * Past-window annualised-yield computation (Tranche-2 Track A.4).
 *
 * Per ADR 031 §"User-facing display — past 30-day realised APY with
 * disclaimer", the LOOPUSD / LOOPEUR vault-share UX surfaces the
 * realised yield over a trailing window with a "no guarantee of
 * future performance" disclaimer. The number comes from on-chain
 * share-price history for the vault assets and from on-chain mint
 * history for GBPLOOP — same display semantics for both, computed
 * from different sources.
 *
 * This module provides the source-agnostic pure-function primitive:
 * given two reference points (share price, or accrued total),
 * compute the annualised growth rate. Callers (Track G UX) wire the
 * source-side data fetch separately. No vendor SDK dependencies, no
 * IO; trivially unit-testable in isolation.
 *
 * Annualisation uses the standard `(end / start)^(365 / days) - 1`
 * compounding formula. A 30-day window growing 0.25% annualises to
 * ~3.04%; a 7-day window growing 0.06% annualises to ~3.16%. Both
 * are realised, past-window numbers — neither implies a forecast.
 */

export interface AnnualisedRateInput {
  /**
   * Reference value at the START of the window — a share price for
   * vault tokens, or an accrued total for off-chain accrual schemes.
   * Must be > 0 to compute a meaningful growth ratio.
   */
  startValue: number;
  /**
   * Reference value at the END of the window — the same shape as
   * `startValue`. Must be > 0.
   */
  endValue: number;
  /**
   * Window length in days. Must be > 0. Standard usage is 30; the
   * "past 30-day APY" framing in ADR 031 is the default surface,
   * but the function is window-agnostic so 7 / 90 / etc work too.
   */
  windowDays: number;
}

export type AnnualisedRateResult =
  | { ok: true; rate: number }
  | {
      ok: false;
      reason: 'invalid_start_value' | 'invalid_end_value' | 'invalid_window' | 'non_finite_result';
    };

/**
 * Days per year used for annualisation. ADR 031 §"GBPLOOP nightly
 * payout mechanism" uses 365 for the daily interest split
 * (`balance × (3% / 365)`); using 365 here keeps the two surfaces
 * arithmetically aligned and matches typical retail-finance
 * conventions. Leap years are not adjusted — the half-day error
 * over a 30-day window rounds out below the rate's display
 * precision (~0.01%).
 */
const DAYS_PER_YEAR = 365;

/**
 * Computes the annualised growth rate over a window. Returns the
 * rate as a unit-fraction (e.g. 0.0312 = 3.12%); UI converts to
 * percentage at display time.
 *
 * Returns a discriminated `{ ok: false, reason }` instead of
 * throwing on bad input. The display layer can render "—" or
 * "Pending data" without try/catch. NaN / Infinity in the result
 * (would happen if endValue is 0 or extremely large for the
 * window) is also rejected — never trust an annualised number
 * that doesn't survive `Number.isFinite`.
 */
export function computeAnnualisedRate(input: AnnualisedRateInput): AnnualisedRateResult {
  const { startValue, endValue, windowDays } = input;

  if (!Number.isFinite(startValue) || startValue <= 0) {
    return { ok: false, reason: 'invalid_start_value' };
  }
  if (!Number.isFinite(endValue) || endValue <= 0) {
    return { ok: false, reason: 'invalid_end_value' };
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    return { ok: false, reason: 'invalid_window' };
  }

  // (end / start)^(365 / days) - 1 — standard compounding
  // annualisation. The exponent compresses for short windows (7
  // days → exponent 52) and stretches for long ones (90 days →
  // exponent 4.06); a single tiny price tick on a short window can
  // therefore project to a large annual number, but that's correct
  // behaviour for the formula. UI should pair this with a window
  // label so users see "past 7 days: 3.5%" not "annual: 3.5%".
  const ratio = endValue / startValue;
  const exponent = DAYS_PER_YEAR / windowDays;
  const rate = Math.pow(ratio, exponent) - 1;

  if (!Number.isFinite(rate)) {
    return { ok: false, reason: 'non_finite_result' };
  }
  return { ok: true, rate };
}

/**
 * Convenience: standardised 30-day APY surface (ADR 031 default).
 * Sugar over `computeAnnualisedRate({ ..., windowDays: 30 })`.
 */
export function computePast30DayApy(args: {
  sharePriceNow: number;
  sharePriceAt30dAgo: number;
}): AnnualisedRateResult {
  return computeAnnualisedRate({
    startValue: args.sharePriceAt30dAgo,
    endValue: args.sharePriceNow,
    windowDays: 30,
  });
}
