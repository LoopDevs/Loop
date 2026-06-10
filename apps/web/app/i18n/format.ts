/**
 * Locale-aware `Intl` formatting (ADR 034 Phase 1).
 *
 * The locale seam for path-based routing. Every user-facing price, number, and
 * date should flow through here so a `/gb/en` page renders £ with UK separators
 * and a `/de/en` page renders € with German separators — driven by the URL's
 * country segment, not a hardcoded `$`. The same `Intl` output also feeds
 * `Offer.priceCurrency` in structured data (ADR 034 §SEO).
 *
 * Pure + SSR-safe: no browser globals, so it runs identically in the SSR loader,
 * the static mobile export, and the hydrated client. The locale is derived from
 * the route, never `navigator.language` — that's what keeps server and client
 * render in agreement (no US flash).
 *
 * This supersedes the ad-hoc helpers in `utils/money.ts`; consumers migrate to
 * these in ADR 034 Phase 3, and `utils/money.ts` is removed in Phase 5.
 */

import { DEFAULT_LANG } from '@loop/shared';

/**
 * BCP-47 locale tag from the route's language + country segments — e.g.
 * `('en', 'gb')` → `'en-GB'`. This is exactly the tag `Intl` and `hreflang`
 * both want, so the routing param feeds formatting and SEO from one source.
 */
export function localeTag(lang: string, country: string): string {
  const l = (lang || DEFAULT_LANG).toLowerCase();
  const c = (country || '').toUpperCase();
  return c ? `${l}-${c}` : l;
}

/**
 * Currency amount in the given locale. `Intl.NumberFormat` throws on an invalid
 * ISO-4217 code, so we fall back to a readable `"1.23 XYZ"` rather than crashing
 * the page if the backend ever sends an unknown currency.
 */
export function formatCurrency(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Narrow currency symbol for compact range / card displays (`"£10–£250"`).
 * Locale-aware so `CAD` renders `"$"` under `en-CA` but `"CA$"` under `en-US`.
 * Falls back to `"$"` on an unknown code.
 */
export function currencySymbol(currency: string, locale?: string): string {
  try {
    const parts = new Intl.NumberFormat(locale ?? 'en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? '$';
  } catch {
    return '$';
  }
}

/** Plain number in the given locale (thousands separators, no currency). */
export function formatNumber(value: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
