/**
 * Country model (ADR 034) — the per-country locale that drives path-based
 * routing (`/:country/:lang`), the merchant filter, and the price-display
 * currency on loopfinance.io.
 *
 * Supersedes the four-region model in `regions.ts` (US / CA / UK / EUR). Both
 * coexist during the routing migration; `regions.ts` is retired in ADR 034
 * Phase 5.
 *
 * The country segment in the URL is the **lowercased** ISO 3166-1 alpha-2 code
 * (`/gb/en`); the canonical {@link Country.code} here is uppercase.
 *
 * The list is the live catalogue's currency spread (USD / GBP / CAD / EUR as of
 * 2026-06) expanded to every country those currencies serve — US for USD, GB
 * for GBP, CA for CAD, and the full Eurozone for EUR, so a EUR merchant surfaces
 * in DE, FR, IT, … individually (the ADR's per-country rule). Eurozone members
 * with no merchant tagged to them yet still get a row: a EUR merchant matches
 * them by currency, so the grid is populated even before a country-tagged
 * merchant exists (the "thin long-tail catalogue" the ADR calls out). Long-tail
 * currencies the supplier sync adds later get their countries appended here.
 *
 * As in `regions.ts`, a country's `currency` is the **display** currency for
 * merchant prices — deliberately separate from a user's cashback *home currency*
 * (`HomeCurrency` in `loop-asset.ts`), which is 1:1 with a LOOP asset. There is
 * no CADLOOP, so CAD stays display-only until a CAD-backed asset exists.
 */

import type { Merchant } from './merchants.js';

/** Display currencies present in the live catalogue (ISO 4217). */
export const SUPPORTED_CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Language segments we route. English-only today; the segment future-proofs
 * real localisation (`/de/de`) so adding a language is a translation drop, not
 * a routing refactor (ADR 034 §7). */
export const SUPPORTED_LANGS = ['en'] as const;
export type LangCode = (typeof SUPPORTED_LANGS)[number];

export interface Country {
  /** ISO 3166-1 alpha-2, uppercase canonical (e.g. 'US', 'GB', 'DE'). */
  code: string;
  /** Human label for the selector (e.g. 'United States'). */
  label: string;
  /** Flag emoji for the selector. */
  flag: string;
  /** Display currency for merchant prices in this country. */
  currency: SupportedCurrency;
}

/** Eurozone members (ISO 3166-1 alpha-2) that display in EUR. Mirrors
 * `EUROZONE_COUNTRIES` in `regions.ts`; kept local so the country list is the
 * single source of truth for ADR 034 routing. */
const EUROZONE: ReadonlyArray<Omit<Country, 'currency'>> = [
  { code: 'FR', label: 'France', flag: '🇫🇷' },
  { code: 'DE', label: 'Germany', flag: '🇩🇪' },
  { code: 'IT', label: 'Italy', flag: '🇮🇹' },
  { code: 'ES', label: 'Spain', flag: '🇪🇸' },
  { code: 'NL', label: 'Netherlands', flag: '🇳🇱' },
  { code: 'IE', label: 'Ireland', flag: '🇮🇪' },
  { code: 'BE', label: 'Belgium', flag: '🇧🇪' },
  { code: 'AT', label: 'Austria', flag: '🇦🇹' },
  { code: 'FI', label: 'Finland', flag: '🇫🇮' },
  { code: 'PT', label: 'Portugal', flag: '🇵🇹' },
  { code: 'GR', label: 'Greece', flag: '🇬🇷' },
  { code: 'LU', label: 'Luxembourg', flag: '🇱🇺' },
  { code: 'SK', label: 'Slovakia', flag: '🇸🇰' },
  { code: 'SI', label: 'Slovenia', flag: '🇸🇮' },
  { code: 'LT', label: 'Lithuania', flag: '🇱🇹' },
  { code: 'LV', label: 'Latvia', flag: '🇱🇻' },
  { code: 'EE', label: 'Estonia', flag: '🇪🇪' },
  { code: 'CY', label: 'Cyprus', flag: '🇨🇾' },
  { code: 'MT', label: 'Malta', flag: '🇲🇹' },
  { code: 'HR', label: 'Croatia', flag: '🇭🇷' },
];

/** Every routable country, in selector display order (anchors first, then the
 * Eurozone). The URL country segment is `code.toLowerCase()`. */
export const COUNTRIES: readonly Country[] = [
  { code: 'US', label: 'United States', flag: '🇺🇸', currency: 'USD' },
  { code: 'GB', label: 'United Kingdom', flag: '🇬🇧', currency: 'GBP' },
  { code: 'CA', label: 'Canada', flag: '🇨🇦', currency: 'CAD' },
  ...EUROZONE.map((c): Country => ({ ...c, currency: 'EUR' })),
];

/** The country a bare `/` (or an unrecognised locale) falls back to. */
export const DEFAULT_COUNTRY = 'US';
/** The language a bare locale falls back to. */
export const DEFAULT_LANG: LangCode = 'en';

const COUNTRY_BY_CODE: ReadonlyMap<string, Country> = new Map(COUNTRIES.map((c) => [c.code, c]));

/** Look up a {@link Country} by ISO code (case-insensitive); `undefined` if we
 * don't route it. */
export function countryByCode(code: string | null | undefined): Country | undefined {
  if (!code) return undefined;
  return COUNTRY_BY_CODE.get(code.toUpperCase());
}

/** Is this an ISO country code we route? */
export function isSupportedCountryCode(code: string | null | undefined): boolean {
  return !!code && COUNTRY_BY_CODE.has(code.toUpperCase());
}

/** Is this a language segment we route? */
export function isSupportedLang(lang: string | null | undefined): lang is LangCode {
  return !!lang && (SUPPORTED_LANGS as readonly string[]).includes(lang.toLowerCase());
}

/** Display currency for a country; `undefined` if unrouted. */
export function currencyOf(code: string | null | undefined): SupportedCurrency | undefined {
  return countryByCode(code)?.currency;
}

/** Every country that displays in `currency` (e.g. `'EUR'` → the Eurozone). */
export function countriesForCurrency(currency: string): Country[] {
  const target = currency.toUpperCase();
  return COUNTRIES.filter((c) => c.currency === target);
}

/**
 * Resolve a (possibly unknown) ISO country code from geo-IP / `Accept-Language`
 * to a routable country code, lowercased for the URL path. Falls back to
 * {@link DEFAULT_COUNTRY}. Used by the `/` geo-redirect loader (ADR 034 Phase 2).
 */
export function resolveCountryPath(code: string | null | undefined): string {
  return (isSupportedCountryCode(code) ? code!.toUpperCase() : DEFAULT_COUNTRY).toLowerCase();
}

/**
 * Country↔merchant visibility rule (ADR 034 §Decision-2). A merchant shows in
 * country `C` when `merchant.country === C` **OR** its display currency equals
 * `currencyOf(C)` — so a EUR merchant appears in every Eurozone country and a
 * GBP merchant in GB. No backend change; reads fields we already expose.
 *
 * A merchant tagged with neither a country nor a currency stays visible
 * everywhere — a data-gap fallback that preserves the pre-ADR-034 `!m.country`
 * behaviour. (No such rows exist in the live catalogue, but the guard keeps a
 * future sync gap from silently hiding a brand.)
 */
export function merchantInCountry(
  merchant: Pick<Merchant, 'country' | 'denominations'>,
  country: string,
): boolean {
  const target = country.toUpperCase();
  const merchantCountry = merchant.country?.toUpperCase();
  const merchantCurrency = merchant.denominations?.currency?.toUpperCase();

  if (!merchantCountry && !merchantCurrency) return true;
  if (merchantCountry && merchantCountry === target) return true;

  const countryCurrency = currencyOf(target);
  return !!merchantCurrency && !!countryCurrency && merchantCurrency === countryCurrency;
}
