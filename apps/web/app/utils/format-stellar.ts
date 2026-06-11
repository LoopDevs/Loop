/**
 * Stellar amount formatting for admin surfaces.
 *
 * Consolidates the `fmtStroops` helper that had been copy-pasted into
 * eight admin routes/components (comprehensive-audit 2026-06-11,
 * Part IV phase 10). One canonical implementation: bigint-safe
 * pad/slice arithmetic over the stroop string (no `Number(BigInt(...))`
 * round-trip on the raw value), em-dash on null / non-numeric input,
 * thousands separators pinned to `ADMIN_LOCALE` (A2-1521).
 *
 * Sibling to `@loop/shared`'s `formatMinorCurrency` (2-decimal fiat
 * minor units) — stroops are 7-decimal Stellar asset units, so the
 * slice width differs and trailing zeros are trimmed rather than
 * padded to a fixed fraction.
 */
import { ADMIN_LOCALE } from './locale';

/**
 * `"12500000"` + `"GBPLOOP"` → `"1.25 GBPLOOP"`.
 *
 * Accepts the bigint-as-string serialisation the backend uses for
 * stroop amounts. `null` (missing treasury snapshot field) and
 * non-numeric garbage both render an em-dash rather than `NaN`.
 */
export function fmtStroops(stroops: string | null, code: string): string {
  if (stroops === null) return '—';
  const negative = stroops.startsWith('-');
  const digits = negative ? stroops.slice(1) : stroops;
  if (!/^\d+$/.test(digits)) return '—';
  const padded = digits.padStart(8, '0');
  const whole = padded.slice(0, -7);
  const fractionRaw = padded.slice(-7).replace(/0+$/, '');
  const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
  const sign = negative ? '-' : '';
  return `${sign}${Number(whole).toLocaleString(ADMIN_LOCALE)}${fraction} ${code}`;
}
