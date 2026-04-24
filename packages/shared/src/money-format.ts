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
 * Non-goals:
 *   - 0-decimal chart variant (lives in `MonthlyCashbackChart` —
 *     different contract: rounds to whole units for the bar chart).
 *   - Number-input formatters (the `fmtMinor` in `admin.users.$userId`
 *     uses `Number()` and is fine for per-user balances; only
 *     fleet-wide sums risk 2^53 overflow).
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
 * arithmetic applies. The 2^53 precision window is not enough for
 * fleet-wide lifetime-cashback totals at scale, so the helper never
 * relies on it — the Number cast only touches the whole/frac
 * components after the bigint split.
 *
 * Non-integer numbers are floored (drops to minor-unit precision);
 * non-finite numbers return `"—"` so a bad backend row doesn't
 * render `NaN` to operators.
 *
 * Unknown ISO codes → falls back to `"<amount> <code>"`. Intl's
 * behaviour with unassigned 3-letter codes is engine-defined
 * (V8 accepts `XYZ`; JSC may not), so the fallback catches
 * engine-level throws rather than depending on the silent-accept.
 *
 * Locale is pinned `en-US` per the admin-facing policy (A2-1521 +
 * `apps/web/app/utils/locale.ts`). User-facing surfaces that want
 * the browser locale should format themselves with `USER_LOCALE`;
 * they're rendering per-user amounts where Number-cast is safe.
 */
export function formatMinorCurrency(minor: bigint | string | number, currency: string): string {
  const big = coerceMinor(minor);
  if (big === null) return '—';
  const neg = big < 0n;
  const abs = neg ? -big : big;
  const major = Number(abs / 100n);
  const frac = Number(abs % 100n) / 100;
  const total = (neg ? -1 : 1) * (major + frac);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(total);
  } catch {
    return `${total.toFixed(2)} ${currency}`;
  }
}

function coerceMinor(minor: bigint | string | number): bigint | null {
  if (typeof minor === 'bigint') return minor;
  if (typeof minor === 'number') {
    if (!Number.isFinite(minor)) return null;
    return BigInt(Math.trunc(minor));
  }
  try {
    return BigInt(minor);
  } catch {
    return null;
  }
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
