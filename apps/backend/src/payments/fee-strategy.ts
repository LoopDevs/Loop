/**
 * A2-1921 — Stellar payout fee-bump strategy.
 *
 * Under Stellar network congestion the SDK default `BASE_FEE`
 * (100 stroops) gets out-bid by user-side traffic and the submit
 * returns `tx_insufficient_fee` (classified as `transient_rebuild`
 * in `payout-submit.ts`). Without bumping the fee on retry, the
 * worker re-submits at the same insufficient amount → same failure
 * → eventual terminal `failed` for what's actually just a
 * transient market condition.
 *
 * Strategy: **exponential bump per attempt with a cap**. The first
 * submit uses `LOOP_PAYOUT_FEE_BASE_STROOPS`; each retry multiplies
 * by `LOOP_PAYOUT_FEE_MULTIPLIER` until reaching
 * `LOOP_PAYOUT_FEE_CAP_STROOPS`. Defaults sized so the
 * 100→200→400→800→1600-stroop curve clears typical sustained
 * congestion within the 5-attempt budget, while the cap (100k
 * stroops = 0.01 XLM ≈ $0.001) keeps fees trivial even in the
 * worst case.
 *
 * Why exponential rather than network-fee-stat-based: ADR 016
 * deliberately keeps payouts simple. Pulling Horizon
 * `/fee_stats` per submit adds another upstream dependency on the
 * critical-path settlement loop. Exponential bump is dumb but
 * correct — under any sustained congestion the curve eventually
 * clears (or tops out at the cap, surfacing the row to ops).
 *
 * The strategy is per-payout, not per-pool. Two concurrent
 * payouts on different rows each track their own attempt count
 * via the row's `attempts` column.
 */

export interface FeeStrategyOptions {
  baseFeeStroops: number;
  capFeeStroops: number;
  multiplier: number;
}

/**
 * Compute the fee for a given attempt index. Attempt 1 = base,
 * attempt 2 = base × multiplier, … capped at `capFeeStroops`.
 *
 * Exposed as a string because the SDK's `TransactionBuilder`
 * accepts string fees (and the tests want exact comparison
 * without floating-point drift). Caller passes whatever the
 * row's `attempts` column says + 1 (to count the attempt
 * we're about to make, not the prior one).
 */
export function feeForAttempt(attempt: number, opts: FeeStrategyOptions): string {
  // Defensive: attempts < 1 would mean we're somehow asking before
  // the first try — clamp to 1 so the curve still starts at base.
  const idx = Math.max(1, Math.floor(attempt));
  // exponent = idx - 1 so attempt=1 → multiplier^0 = 1.
  const raw = opts.baseFeeStroops * Math.pow(opts.multiplier, idx - 1);
  const capped = Math.min(raw, opts.capFeeStroops);
  // Floor to integer stroops — Stellar rejects non-integer fees.
  return Math.floor(capped).toString();
}
