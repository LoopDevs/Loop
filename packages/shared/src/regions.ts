/**
 * Region model — the original US / CA / UK / EUR selector.
 *
 * **Superseded by the per-country model in `countries.ts` (ADR 034).** The web's
 * region store + selector are retired; what remains live here is `GeoResponse`
 * (the `/api/public/geo` shape) and the backend's `regionForCountry` /
 * `DEFAULT_REGION`, which still populate the (now-vestigial) `GeoResponse.region`
 * field for backward compatibility. New code should use `countries.ts`
 * (`COUNTRIES`, `currencyOf`, `merchantInCountry`).
 *
 * NOTE: a region's `currency` here is the **display** currency for merchant prices. It is
 * deliberately separate from the user's cashback *home currency* (`HomeCurrency` in
 * `loop-asset.ts`), which is 1:1 with a LOOP asset (USDLOOP/GBPLOOP/EURLOOP). There is no
 * CADLOOP, so CAD is display-only until a CAD-backed asset exists.
 */

export const REGION_CODES = ['US', 'CA', 'UK', 'EUR'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

/** Eurozone ISO 3166-1 alpha-2 codes that map to the EUR region. */
export const EUROZONE_COUNTRIES = [
  'FR',
  'DE',
  'IT',
  'ES',
  'NL',
  'IE',
  'BE',
  'AT',
  'FI',
  'PT',
  'GR',
  'LU',
  'SK',
  'SI',
  'LT',
  'LV',
  'EE',
  'CY',
  'MT',
  'HR',
] as const;

export interface Region {
  code: RegionCode;
  label: string;
  /** Flag emoji for the selector. */
  flag: string;
  /** ISO 3166-1 alpha-2 country codes that fall under this region. */
  countries: readonly string[];
  /** Display currency for merchant prices in this region. */
  currency: 'USD' | 'CAD' | 'GBP' | 'EUR';
  currencySymbol: string;
}

const US_REGION: Region = {
  code: 'US',
  label: 'United States',
  flag: '🇺🇸',
  countries: ['US'],
  currency: 'USD',
  currencySymbol: '$',
};

export const REGIONS: readonly Region[] = [
  US_REGION,
  {
    code: 'CA',
    label: 'Canada',
    flag: '🇨🇦',
    countries: ['CA'],
    currency: 'CAD',
    currencySymbol: '$',
  },
  {
    code: 'UK',
    label: 'United Kingdom',
    flag: '🇬🇧',
    countries: ['GB'],
    currency: 'GBP',
    currencySymbol: '£',
  },
  {
    code: 'EUR',
    label: 'Europe',
    flag: '🇪🇺',
    countries: EUROZONE_COUNTRIES,
    currency: 'EUR',
    currencySymbol: '€',
  },
];

export const DEFAULT_REGION: RegionCode = 'US';

const COUNTRY_TO_REGION: Readonly<Record<string, RegionCode>> = (() => {
  const map: Record<string, RegionCode> = {};
  for (const region of REGIONS) {
    for (const country of region.countries) map[country] = region.code;
  }
  return map;
})();

/** Resolve a region from an ISO country code; falls back to {@link DEFAULT_REGION}. */
export function regionForCountry(country: string | null | undefined): RegionCode {
  if (!country) return DEFAULT_REGION;
  return COUNTRY_TO_REGION[country.toUpperCase()] ?? DEFAULT_REGION;
}

/** Look up the {@link Region} for a code; falls back to the first region (US). */
export function regionByCode(code: string | null | undefined): Region {
  return REGIONS.find((r) => r.code === code) ?? US_REGION;
}

/** Is this country covered by one of our regions? */
export function isSupportedCountry(country: string | null | undefined): boolean {
  return !!country && country.toUpperCase() in COUNTRY_TO_REGION;
}

/** Response shape for `GET /api/public/geo` (shared by backend + web). */
export interface GeoResponse {
  /** ISO 3166-1 alpha-2 country code; empty string when undetermined. */
  countryCode: string;
  /** Region derived from {@link countryCode} (defaults to US when undetermined). */
  region: RegionCode;
}
