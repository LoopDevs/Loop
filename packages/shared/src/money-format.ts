/**
 * Money-format helpers (ADR 019 consolidation).
 *
 * Bigint-safe primitives used by the cashback / flywheel UI across
 * both admin and user-facing components. Lived locally in
 * `apps/web/.../FlywheelChip.tsx` and `CashbackSummaryChip.tsx`
 * through iteration; four+ consumers now exist (FlywheelChip,
 * AdminUserFlywheelChip, MerchantsFlywheelShareCard,
 * FleetFlywheelHeadline, CashbackSummaryChip), so the helpers
 * consolidate here.
 *
 * Scope: two helpers, both pure, both bigint-safe.
 *
 * `formatMinorCurrency` covers the 0-decimal chart variant via
 * `opts.fractionDigits` (CF-23 — the bar charts and treasury summaries
 * now delegate here instead of carrying their own lossy `Number()/100`
 * helpers).
 *
 * Keep this module dependency-free — no React, no DOM, no platform
 * APIs beyond `Intl.NumberFormat` which is runtime-universal.
 */

/**
 * Minor-units → localised currency string with two decimals.
 *
 * `formatMinorCurrency(4200n, 'GBP')` → `"£42.00"` (or locale
 * equivalent).
 *
 * Accepts `bigint | string | number` (A2-1520). Strings come from
 * backend JSON (admin aggregates serialise bigints as strings to
 * survive JSON.stringify); numbers are tolerated for legacy call
 * sites but internally converted to bigint so the same pad/slice
 * arithmetic applies.
 *
 * Bigint-exact at every magnitude (CF-23 / P2-SHARED-01). The whole
 * part is formatted by `Intl.NumberFormat` over the **bigint** of
 * major units — `Intl` consumes `bigint` natively and never routes it
 * through a `Number`, so values past 2^53 minor units (≈ $90T in
 * cents — the exact fleet/solvency aggregates this module exists to
 * protect) group correctly instead of silently rounding. The two-
 * decimal fraction (`abs % 100n`, padded) is spliced into the parts
 * stream, so no IEEE-754 division ever touches the displayed digits.
 *
 * Non-integer numbers are truncated toward zero (`Math.trunc`, dropping
 * any sub-minor-unit fraction) — NOT floored: floor and trunc only
 * differ for a negative fractional input, and this drops the magnitude's
 * fraction symmetrically about zero. In practice minor units are whole
 * cents/stroops (bigint and string inputs are always integers; the only
 * `number` call sites pass integers or pre-rounded values), so this
 * conversion is a no-op on the values that actually occur. Non-finite
 * numbers return `"—"` so a bad backend row doesn't render `NaN` to
 * operators.
 *
 * `opts.fractionDigits` (default `2`) drops to `0` for summary/chart
 * surfaces ("$1,234" bars). `opts.locale` (default `en-US`, the
 * admin-facing policy — A2-1521 + `apps/web/app/utils/locale.ts`)
 * lets user-facing surfaces pass the browser locale.
 *
 * Unknown ISO codes → falls back to `"<amount> <code>"` built from the
 * same bigint split (still exact). Intl's behaviour with unassigned
 * 3-letter codes is engine-defined (V8 accepts `XYZ`; JSC may not), so
 * the fallback catches engine-level throws rather than depending on
 * the silent-accept.
 */
export function formatMinorCurrency(
  minor: bigint | string | number,
  currency: string,
  opts?: { fractionDigits?: 0 | 2; locale?: string },
): string {
  const big = coerceMinor(minor);
  if (big === null) return '—';
  const fractionDigits = opts?.fractionDigits ?? 2;
  const locale = opts?.locale ?? 'en-US';
  const neg = big < 0n;
  const abs = neg ? -big : big;
  // Bigint-exact split: major units stay a bigint so Intl groups them
  // without a lossy Number cast; the fraction is a fixed-width string.
  const major = abs / 100n;
  const fracStr = (abs % 100n).toString().padStart(2, '0');
  const sign = neg ? '-' : '';
  try {
    // Format the integer-major bigint with zero fraction, then splice
    // our own `.NN` in (2-decimal case) so the whole part is never
    // coerced through a Number.
    const nf = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    if (fractionDigits === 0) {
      const formatted = nf.format(major);
      return neg ? `-${formatted}` : formatted;
    }
    // Insert the fraction directly after the integer run (handles both
    // leading- and trailing-symbol locales) so grouping stays intact.
    // Use the locale's own decimal separator (`,` in de-DE, `.` in
    // en-US) so a non-en-US caller doesn't get a mixed `1.234,56`.
    const decimalSep = decimalSeparator(locale);
    const parts = nf.formatToParts(major);
    let out = '';
    let inserted = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      out += part.value;
      const next = parts[i + 1];
      if (
        !inserted &&
        part.type === 'integer' &&
        (next === undefined || (next.type !== 'integer' && next.type !== 'group'))
      ) {
        out += `${decimalSep}${fracStr}`;
        inserted = true;
      }
    }
    return neg ? `-${out}` : out;
  } catch {
    const frac = fractionDigits === 0 ? '' : `.${fracStr}`;
    return `${sign}${major.toString()}${frac} ${currency}`;
  }
}

function coerceMinor(minor: bigint | string | number): bigint | null {
  if (typeof minor === 'bigint') return minor;
  if (typeof minor === 'number') {
    if (!Number.isFinite(minor)) return null;
    // Truncate toward zero (not floor) so a fractional magnitude drops its
    // sub-minor-unit part symmetrically about zero. Minor units are whole
    // in practice, so this only ever fires defensively.
    return BigInt(Math.trunc(minor));
  }
  try {
    return BigInt(minor);
  } catch {
    return null;
  }
}

/** The locale's decimal separator (`.` en-US, `,` de-DE). Defaults to `.`. */
function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(1.1)
      .find((p) => p.type === 'decimal')?.value ?? '.'
  );
}

/**
 * Bigint-safe percentage as a one-decimal string with the `%` suffix.
 *
 * `pctBigint(50n, 200n)` → `"25.0%"`
 * `pctBigint(1n, 3n)` → `"33.3%"`
 *
 * Returns `null` when the denominator is ≤ 0 so callers render an
 * em-dash (or similar) rather than "NaN%" or "Infinity%".
 *
 * Implementation: `(num * 10000n) / denom` produces basis-points
 * (×100) that fit comfortably inside `Number.MAX_SAFE_INTEGER`
 * for any realistic fleet total, so the final `Number(...)/100`
 * coercion keeps precision where it matters (the integer part).
 */
export function pctBigint(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bp = (numerator * 10000n) / denominator;
  const pct = Number(bp) / 100;
  return `${pct.toFixed(1)}%`;
}
