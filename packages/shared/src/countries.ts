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

/** Display currencies present in the live catalogue (ISO 4217). USD/GBP/EUR/CAD
 * are the anchor markets; AED/INR/SAR/AUD/MXN are the extended supplier-currency
 * markets surfaced under ADR 035 (display-only, no LOOP cashback asset). */
export const SUPPORTED_CURRENCIES = [
  'USD',
  'GBP',
  'EUR',
  'CAD',
  'AED',
  'INR',
  'SAR',
  'AUD',
  'MXN',
] as const;
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
 * Eurozone, then the extended supplier-currency markets). The URL country
 * segment is `code.toLowerCase()`. */
export const COUNTRIES: readonly Country[] = [
  { code: 'US', label: 'United States', flag: '🇺🇸', currency: 'USD' },
  { code: 'GB', label: 'United Kingdom', flag: '🇬🇧', currency: 'GBP' },
  { code: 'CA', label: 'Canada', flag: '🇨🇦', currency: 'CAD' },
  ...EUROZONE.map((c): Country => ({ ...c, currency: 'EUR' })),
  // Extended supplier-currency markets (ADR 035) — EzPin catalogue depth of ≥15
  // enabled merchants. Display-only like CAD: priced in the local currency with
  // no LOOP cashback asset yet. Thinner currencies (NZD/TRY/KWD/… <15 merchants)
  // stay catalogue-only until they have the depth to populate a country page.
  { code: 'AE', label: 'United Arab Emirates', flag: '🇦🇪', currency: 'AED' },
  { code: 'IN', label: 'India', flag: '🇮🇳', currency: 'INR' },
  { code: 'SA', label: 'Saudi Arabia', flag: '🇸🇦', currency: 'SAR' },
  { code: 'AU', label: 'Australia', flag: '🇦🇺', currency: 'AUD' },
  { code: 'MX', label: 'Mexico', flag: '🇲🇽', currency: 'MXN' },
];

/**
 * Rough initial map viewport per country (UX-08 — `docs/ux-pass-2026-07-09.md`).
 * Deliberately not survey-precise centroids — just enough that `/map` opens
 * looking at roughly the right part of the world for the active locale
 * instead of a fixed North-America-wide default for every country. `zoom` is
 * a Leaflet zoom level chosen so the country's populated area is broadly in
 * frame. Every {@link COUNTRIES} entry must have a row here —
 * `countries.test.ts` enforces that so a newly-added country doesn't
 * silently fall back to the US view.
 */
export interface MapView {
  lat: number;
  lng: number;
  zoom: number;
}

const MAP_VIEW_BY_COUNTRY: Readonly<Record<string, MapView>> = {
  US: { lat: 39.8, lng: -98.6, zoom: 4 },
  GB: { lat: 54.0, lng: -2.5, zoom: 5 },
  CA: { lat: 56.1, lng: -106.3, zoom: 3 },
  FR: { lat: 46.6, lng: 2.2, zoom: 5 },
  DE: { lat: 51.2, lng: 10.4, zoom: 5 },
  IT: { lat: 42.8, lng: 12.6, zoom: 5 },
  ES: { lat: 40.2, lng: -3.7, zoom: 5 },
  NL: { lat: 52.2, lng: 5.3, zoom: 7 },
  IE: { lat: 53.4, lng: -8.0, zoom: 6 },
  BE: { lat: 50.6, lng: 4.5, zoom: 7 },
  AT: { lat: 47.6, lng: 14.1, zoom: 6 },
  FI: { lat: 63.2, lng: 25.7, zoom: 4 },
  PT: { lat: 39.6, lng: -8.0, zoom: 6 },
  GR: { lat: 39.1, lng: 22.9, zoom: 6 },
  LU: { lat: 49.8, lng: 6.1, zoom: 9 },
  SK: { lat: 48.7, lng: 19.5, zoom: 7 },
  SI: { lat: 46.1, lng: 14.8, zoom: 8 },
  LT: { lat: 55.2, lng: 23.9, zoom: 7 },
  LV: { lat: 56.9, lng: 24.6, zoom: 7 },
  EE: { lat: 58.6, lng: 25.0, zoom: 7 },
  CY: { lat: 35.1, lng: 33.4, zoom: 8 },
  MT: { lat: 35.9, lng: 14.4, zoom: 10 },
  HR: { lat: 45.1, lng: 15.2, zoom: 7 },
  AE: { lat: 23.4, lng: 53.8, zoom: 6 },
  IN: { lat: 22.4, lng: 78.7, zoom: 4 },
  SA: { lat: 23.9, lng: 45.1, zoom: 5 },
  AU: { lat: -25.3, lng: 133.8, zoom: 4 },
  MX: { lat: 23.6, lng: -102.5, zoom: 4 },
};

/**
 * Initial map view for a country code; `undefined` if unrouted (callers
 * fall back to the {@link MAP_VIEW_BY_COUNTRY}.US-equivalent default).
 */
export function mapViewOf(code: string | null | undefined): MapView | undefined {
  if (!code) return undefined;
  return MAP_VIEW_BY_COUNTRY[code.toUpperCase()];
}

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
 * Best-guess supported country from an `Accept-Language` header — the
 * geo-redirect fallback when geo-IP can't place the visitor (the free
 * GeoLite2 DB misses smaller ISPs, so a real UK visitor can resolve to
 * empty and wrongly default to the US). Reads only the REGION subtag
 * (`en-GB` → GB), never the language alone — a language doesn't pin a
 * country (`en` could be GB/US/AU/…). Returns a supported ISO code
 * (uppercase) in browser-preference order, or '' when none maps to a
 * supported market. Pair with {@link resolveCountryPath}, which turns
 * '' into {@link DEFAULT_COUNTRY}.
 */
export function countryFromAcceptLanguage(header: string | null | undefined): string {
  if (!header) return '';
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim(); // "en-GB;q=0.9" → "en-GB"
    if (tag === undefined || tag.length === 0) continue;
    const region = tag.split('-')[1]?.trim(); // "en-GB" → "GB"
    if (region !== undefined && isSupportedCountryCode(region)) return region.toUpperCase();
  }
  return '';
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
