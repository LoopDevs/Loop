/**
 * Locale- and currency-aware amount formatter for the order list, purchase
 * confirmation, and anywhere else we display a fiat amount coming back from
 * the backend. Using a hardcoded `$` prefix (the original orders.tsx
 * behaviour) renders non-USD orders as garbage like "$25.00 EUR".
 *
 * Kept as a thin wrapper so the formatting locale can be centralized if we
 * ever add i18n; for now browser locale is a fine default.
 */
export function formatMoney(amount: number, currency: string): string {
  // `Intl.NumberFormat` throws on an invalid ISO-4217 code. Fall back to a
  // plain "1.23 XYZ" rendering instead of crashing the whole page if the
  // backend ever sends us an unknown currency string.
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
