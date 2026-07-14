/**
 * Locale-aware `Intl` formatting — the single web locale-format seam (ADR 034).
 *
 * Every user-facing price, number, and date flows through here so a `/gb/en`
 * page renders £ with UK separators and a `/de/en` page renders € with German
 * separators — driven by the URL's country segment, not a hardcoded `$`. The
 * same `Intl` output also feeds `Offer.priceCurrency` in structured data
 * (ADR 034 §SEO).
 *
 * Pure + SSR-safe: no browser globals, so it runs identically in the SSR loader,
 * the static mobile export, and the hydrated client. The locale is derived from
 * the route (`useLocaleTag()` → the active `/:country/:lang` segments), never
 * `navigator.language` — that's what keeps server and client render in agreement
 * (no US flash).
 *
 * This is the single source of truth for currency/number formatting. The former
 * `utils/money.ts` helpers (locale-agnostic) and `utils/locale.ts#USER_LOCALE`
 * (a browser-locale escape hatch that contradicted the route-driven model and
 * was imported by nobody) were folded in / removed here per the cold-audit
 * CF-22 / P2-QUAL-02 finding — there is no second live currency formatter.
 *
 * The bigint-exact minor-unit path delegates to `@loop/shared`'s
 * `formatMinorCurrency` (the only formatter safe past 2^53 minor units — the
 * fleet/solvency aggregates, CF-23), so this seam adds the *locale* and shared
 * adds the *exactness*.
 */

import { useMemo } from 'react';
import { DEFAULT_LANG, formatMinorCurrency as sharedFormatMinorCurrency } from '@loop/shared';
import { useLocale } from './locale.js';

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
 * The BCP-47 tag for the **active** route locale (`/:country/:lang`). This is the
 * single hook every money/number/date render reads so the figure matches the
 * page's market. Defaults to the home market on unprefixed routes (`useLocale`
 * never invents a locale the visitor didn't choose).
 */
export function useLocaleTag(): string {
  const { lang, country } = useLocale();
  return useMemo(() => localeTag(lang, country), [lang, country]);
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
 * Currency amount rendered with the ISO **code** rather than a symbol
 * (`"EUR 25.00"`, `"USD 25.00"`) — the order-list / order-detail style that
 * disambiguates a £25 from a $25 at a glance. Was `utils/money.ts#formatMoney`;
 * now locale-aware (separators follow the route) but otherwise identical,
 * including the `"1.23 XYZ"` fallback for unknown codes (A-029 regression).
 */
export function formatMoney(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
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

/**
 * Date/time in the given locale — the date analogue of `formatCurrency` /
 * `formatNumber` above, and the reason the header comment can say *every*
 * user-facing date flows through this seam. A `/gb/en` page renders
 * `"20 Apr 2026, 10:02"` and a `/de/en` page renders `"20.04.2026, 10:02"` —
 * driven by the route locale, never the host default (`navigator.language` /
 * the CI box's `LANG`), the same route-driven contract the money formatters
 * hold (ADR 034).
 *
 * `locale` is threaded in from the caller's `useLocaleTag()` (or a fixed ops
 * locale like `ADMIN_LOCALE` on locale-stable admin views) — never read a hook
 * in here; this stays a pure, SSR-safe function. `options` are the usual
 * `Intl.DateTimeFormat` options and pass straight through, so each call site
 * keeps its own month/day/time shape.
 *
 * A malformed `locale` tag is the only throw path (`toLocaleString` raises a
 * `RangeError`); on it we degrade to the raw ISO string rather than crash the
 * page — the same "readable, don't throw" idiom as `formatNumber`'s
 * `String(value)`. An unparseable `iso` does not throw: it renders the
 * platform's `"Invalid Date"`, exactly as the former local `formatDate` copies
 * did.
 */
export function formatDateTime(
  iso: string,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Date(iso).toLocaleString(locale, options);
  } catch {
    return iso;
  }
}

/**
 * Bigint-exact minor-unit → currency string, localised to the route.
 *
 * Thin re-export of `@loop/shared#formatMinorCurrency` with the locale threaded
 * as a positional arg (the shape every web caller wants). Use this — not the
 * shared one with a hardcoded `'en-US'` default — wherever a user-facing money
 * figure renders, passing `useLocaleTag()` as the locale.
 */
export function formatMinorCurrency(
  minor: bigint | string | number,
  currency: string,
  locale?: string,
  opts?: { fractionDigits?: 0 | 2 },
): string {
  // Build opts conditionally — `exactOptionalPropertyTypes` rejects an
  // explicit `undefined` for an optional property.
  const sharedOpts: { fractionDigits?: 0 | 2; locale?: string } = {};
  if (opts?.fractionDigits !== undefined) sharedOpts.fractionDigits = opts.fractionDigits;
  if (locale !== undefined) sharedOpts.locale = locale;
  return sharedFormatMinorCurrency(minor, currency, sharedOpts);
}
