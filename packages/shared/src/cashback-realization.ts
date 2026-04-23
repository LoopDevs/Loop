/**
 * Cashback realization math (ADR 009 / 015).
 *
 * `recycledBps = spent / earned × 10 000` — the share of emitted
 * cashback that has flowed back into new Loop orders, as integer
 * basis points (10 000 = 100.00%).
 *
 * Pure integer math on bigints; exported as a shared helper so every
 * surface computing the flywheel-health KPI agrees on:
 *
 *   - Div-by-zero: 0 when earned ≤ 0 (never throw).
 *   - Overflow clamp: corrupt data where spent > earned clamps to
 *     10 000 rather than reporting > 100%.
 *   - Negative-spent clamp: 0. Negative spent would imply ledger
 *     corruption; treating it as "no recycling" is the conservative
 *     read.
 *   - Return type: `number` in the [0, 10 000] range. Safe to JSON-
 *     serialize and render directly as bps.
 *
 * Used by `/api/admin/cashback-realization` (single-point),
 * `/api/admin/cashback-realization/daily` (time-series), and the
 * web RealizationSparkline (client-side per-day aggregation).
 * Defining this once in `@loop/shared` prevents subtle drift —
 * a renderer that rounds differently from the backend would make
 * the sparkline and the headline card disagree on the same day.
 */
export function recycledBps(earnedMinor: bigint, spentMinor: bigint): number {
  if (earnedMinor <= 0n) return 0;
  const clampedSpent = spentMinor < 0n ? 0n : spentMinor;
  const scaled = (clampedSpent * 10_000n) / earnedMinor;
  const n = Number(scaled);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 10_000 ? 10_000 : n;
}
