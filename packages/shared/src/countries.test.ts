import { describe, expect, it } from 'vitest';

import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  SUPPORTED_CURRENCIES,
  countryFromAcceptLanguage,
  countriesForCurrency,
  countryByCode,
  currencyOf,
  isSupportedCountryCode,
  isSupportedLang,
  mapViewOf,
  merchantInCountry,
  resolveCountryPath,
} from './countries.js';
import { EUROZONE_COUNTRIES } from './regions.js';

describe('countryByCode / isSupportedCountryCode', () => {
  it('resolves case-insensitively', () => {
    expect(countryByCode('us')?.code).toBe('US');
    expect(countryByCode('Gb')?.code).toBe('GB');
    expect(isSupportedCountryCode('de')).toBe(true);
  });

  it('returns undefined / false for unrouted or empty codes', () => {
    expect(countryByCode('JP')).toBeUndefined();
    expect(countryByCode(null)).toBeUndefined();
    expect(countryByCode(undefined)).toBeUndefined();
    expect(countryByCode('')).toBeUndefined();
    expect(isSupportedCountryCode('JP')).toBe(false);
    expect(isSupportedCountryCode(null)).toBe(false);
  });
});

describe('isSupportedLang', () => {
  it('accepts en in any case, rejects everything else', () => {
    expect(isSupportedLang('en')).toBe(true);
    expect(isSupportedLang('EN')).toBe(true);
    expect(isSupportedLang('de')).toBe(false);
    expect(isSupportedLang(null)).toBe(false);
    expect(isSupportedLang(undefined)).toBe(false);
  });
});

describe('currencyOf / countriesForCurrency', () => {
  it('maps anchor markets to their currencies', () => {
    expect(currencyOf('US')).toBe('USD');
    expect(currencyOf('GB')).toBe('GBP');
    expect(currencyOf('CA')).toBe('CAD');
    expect(currencyOf('DE')).toBe('EUR');
    expect(currencyOf('JP')).toBeUndefined();
  });

  it('EUR expands to the full Eurozone, case-insensitively', () => {
    const eur = countriesForCurrency('eur').map((c) => c.code);
    expect(new Set(eur)).toEqual(new Set(EUROZONE_COUNTRIES));
  });

  it('single-country currencies return exactly one country', () => {
    expect(countriesForCurrency('GBP').map((c) => c.code)).toEqual(['GB']);
    expect(countriesForCurrency('INR').map((c) => c.code)).toEqual(['IN']);
  });
});

describe('resolveCountryPath', () => {
  it('lowercases routable codes and falls back to the default', () => {
    expect(resolveCountryPath('GB')).toBe('gb');
    expect(resolveCountryPath('de')).toBe('de');
    expect(resolveCountryPath('JP')).toBe(DEFAULT_COUNTRY.toLowerCase());
    expect(resolveCountryPath(null)).toBe(DEFAULT_COUNTRY.toLowerCase());
    expect(resolveCountryPath(undefined)).toBe(DEFAULT_COUNTRY.toLowerCase());
  });
});

describe('countryFromAcceptLanguage', () => {
  it('reads the region subtag of the first supported entry', () => {
    expect(countryFromAcceptLanguage('en-GB,en;q=0.9')).toBe('GB');
    expect(countryFromAcceptLanguage('it-IT,it;q=0.9,en;q=0.8')).toBe('IT');
    expect(countryFromAcceptLanguage('fr-CA,fr;q=0.8')).toBe('CA');
    expect(countryFromAcceptLanguage('de-DE')).toBe('DE');
  });

  it('skips language-only tags (a language does not pin a country)', () => {
    // `en` alone → no region → no guess (en could be GB/US/AU/…).
    expect(countryFromAcceptLanguage('en')).toBe('');
    expect(countryFromAcceptLanguage('it')).toBe('');
  });

  it('skips unsupported regions and takes the first supported one', () => {
    expect(countryFromAcceptLanguage('ja-JP,en-GB;q=0.9')).toBe('GB');
    expect(countryFromAcceptLanguage('zz-ZZ')).toBe('');
  });

  it('returns "" for empty / missing headers', () => {
    expect(countryFromAcceptLanguage('')).toBe('');
    expect(countryFromAcceptLanguage(null)).toBe('');
    expect(countryFromAcceptLanguage(undefined)).toBe('');
  });

  it('feeds resolveCountryPath as the geo-IP fallback', () => {
    // The real bug: empty geo-IP → without this, DEFAULT_COUNTRY (US).
    expect(resolveCountryPath(countryFromAcceptLanguage('en-GB,en;q=0.9'))).toBe('gb');
    expect(resolveCountryPath(countryFromAcceptLanguage('en'))).toBe(DEFAULT_COUNTRY.toLowerCase());
  });
});

describe('merchantInCountry (ADR 034 §Decision-2)', () => {
  const merchant = (
    country: string | undefined,
    currency: string | undefined,
  ): Parameters<typeof merchantInCountry>[0] =>
    ({
      country,
      denominations: currency ? { currency } : undefined,
    }) as Parameters<typeof merchantInCountry>[0];

  it('matches on explicit merchant country', () => {
    expect(merchantInCountry(merchant('US', undefined), 'us')).toBe(true);
    expect(merchantInCountry(merchant('us', undefined), 'US')).toBe(true);
  });

  it('matches on display-currency equality (EUR merchant in every Eurozone country)', () => {
    for (const c of EUROZONE_COUNTRIES) {
      expect(merchantInCountry(merchant(undefined, 'EUR'), c)).toBe(true);
    }
    expect(merchantInCountry(merchant(undefined, 'GBP'), 'GB')).toBe(true);
  });

  it('rejects a currency/country mismatch', () => {
    expect(merchantInCountry(merchant('US', 'USD'), 'GB')).toBe(false);
    expect(merchantInCountry(merchant(undefined, 'INR'), 'US')).toBe(false);
  });

  it('a merchant with neither country nor currency stays visible everywhere', () => {
    expect(merchantInCountry(merchant(undefined, undefined), 'US')).toBe(true);
    expect(merchantInCountry(merchant(undefined, undefined), 'DE')).toBe(true);
  });

  it('an unrouted target country only matches on explicit merchant country', () => {
    expect(merchantInCountry(merchant('JP', undefined), 'JP')).toBe(true);
    expect(merchantInCountry(merchant(undefined, 'USD'), 'JP')).toBe(false);
  });
});

describe('country model consistency', () => {
  it('every country code is unique and uppercase', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toBe(code.toUpperCase());
  });

  it('every country currency is a supported currency', () => {
    for (const c of COUNTRIES) {
      expect(SUPPORTED_CURRENCIES).toContain(c.currency);
    }
  });

  it('the Eurozone list stays in lockstep with regions.ts', () => {
    // Both files declare the Eurozone independently on purpose (the
    // country list is ADR 034's source of truth) — this pins them to
    // each other so a member added to one side can't silently miss
    // the other.
    const eurCodes = COUNTRIES.filter((c) => c.currency === 'EUR').map((c) => c.code);
    expect(new Set(eurCodes)).toEqual(new Set(EUROZONE_COUNTRIES));
  });

  it('the default country is routable', () => {
    expect(isSupportedCountryCode(DEFAULT_COUNTRY)).toBe(true);
  });
});

// UX-08 (docs/ux-pass-2026-07-09.md): the map's initial viewport is
// locale-aware via a per-country centroid/zoom table instead of a fixed
// North-America-wide default for every country.
describe('mapViewOf (UX-08)', () => {
  it('every routable country has a map view — no silent fallback to the US default', () => {
    for (const c of COUNTRIES) {
      const view = mapViewOf(c.code);
      expect(view, `missing MAP_VIEW_BY_COUNTRY row for ${c.code}`).toBeDefined();
      expect(Number.isFinite(view?.lat)).toBe(true);
      expect(Number.isFinite(view?.lng)).toBe(true);
      expect(view?.zoom).toBeGreaterThan(0);
    }
  });

  it('resolves case-insensitively', () => {
    expect(mapViewOf('gb')).toEqual(mapViewOf('GB'));
  });

  it('is undefined for an unrouted country', () => {
    expect(mapViewOf('JP')).toBeUndefined();
    expect(mapViewOf(null)).toBeUndefined();
    expect(mapViewOf(undefined)).toBeUndefined();
  });

  it('gives different countries a different initial view', () => {
    expect(mapViewOf('US')).not.toEqual(mapViewOf('CA'));
    expect(mapViewOf('US')).not.toEqual(mapViewOf('GB'));
  });
});
