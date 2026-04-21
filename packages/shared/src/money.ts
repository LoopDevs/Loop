/**
 * Currency formatting helpers shared between web + backend.
 *
 * The canonical wire shape for currency amounts throughout the app
 * is bigint-as-string in minor units (cents / pence). Formatters
 * land here instead of one-off inline helpers so the presentation
 * stays consistent across every cashback surface (balance card,
 * ledger history, earned-cashback card, settings history, admin
 * treasury, and future screens).
 *
 * Platform-agnostic: uses `Intl.NumberFormat`, which is native to
 * Node 22 and every modern browser/WebView.
 */

export interface FormatMinorAmountOptions {
  /**
   * When true, emit a leading `+` for non-negative amounts. Matches
   * `Intl.NumberFormat({ signDisplay: 'always' })`. Use this for
   * ledger rows where the sign carries meaning (credit vs debit);
   * leave it off for single-value balance displays.
   */
  signed?: boolean;
}

/**
 * Formats a minor-unit bigint-string (e.g. `"250"` cents) into a
 * localized currency display (e.g. `"$2.50"`).
 *
 * - Accepts `string | bigint | number`. Strings are the default
 *   because our API contract serialises bigint columns as strings;
 *   passing a raw bigint avoids the round-trip when the caller
 *   already has it in memory.
 * - Returns `"—"` on any parse failure — every surface treats this
 *   as a graceful fallback rather than crashing the render.
 * - `currency` must be a 3-letter ISO 4217 code; anything
 *   `Intl.NumberFormat` rejects also returns `"—"`.
 */
export function formatMinorAmount(
  minor: string | bigint | number,
  currency: string,
  opts: FormatMinorAmountOptions = {},
): string {
  try {
    // Normalize to bigint so the >>> 2-decimal divide can't lose
    // precision for values larger than `Number.MAX_SAFE_INTEGER`.
    const asBigInt = typeof minor === 'bigint' ? minor : BigInt(minor);
    // Number() on a bigint is lossy above 2**53 — but a currency
    // amount over ~90 trillion minor units is not a real-world case
    // for this app. The bigint coercion protects the parse; the
    // Number conversion here is a deliberate trade for Intl
    // compatibility.
    const major = Number(asBigInt) / 100;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
      ...(opts.signed === true ? { signDisplay: 'always' as const } : {}),
    }).format(major);
  } catch {
    return '—';
  }
}
