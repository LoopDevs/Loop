/**
 * Cashback-rate formatting for merchant card / directory pills.
 *
 * Consolidates the `formatCashbackPct` helper that had been
 * copy-pasted into `MerchantCard` and `MobileHome` (code-health
 * finding AUD-16). One canonical implementation of the numeric(5,2)
 * wire-shape → compact pill-label transform (ADR 011 / 015).
 */

/**
 * Formats the numeric-string pct for a cashback badge/pill. Drops a
 * trailing `.0` so whole-integer rates read as "5%" rather than
 * "5.0%" (or the backend's `"5.00"`), while partial rates keep their
 * precision ("2.5"). Returns `null` when the rate parses to
 * 0 / negative / unparseable — the caller should translate that to
 * "don't render the badge".
 *
 * Accepts the backend wire shape: numeric(5,2) serialised as a string
 * (e.g. `"2.50"`), plus `null` / `undefined` for "no rate".
 */
export function formatCashbackPct(pct: string | null | undefined): string | null {
  if (pct === null || pct === undefined) return null;
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return null;
  // One decimal place max — rates like 1.25% are rare and would clutter
  // a small pill; we prefer the slightly-less-precise "1.3%" read.
  const rounded = Math.round(n * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, '');
}
