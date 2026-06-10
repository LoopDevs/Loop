/**
 * ADR 034 Phase 1 — country model (`@loop/shared/countries`).
 *
 * Lives in `apps/web` rather than alongside the source in `packages/shared`
 * because the shared package has no test runner wired into CI
 * (`test:coverage --workspaces --if-present` skips it); the web unit job
 * imports `@loop/shared` from source, so these run on every push.
 */
import { describe, it, expect } from 'vitest';
import type { Merchant } from '@loop/shared';
import {
  COUNTRIES,
  SUPPORTED_CURRENCIES,
  DEFAULT_COUNTRY,
  countryByCode,
  isSupportedCountryCode,
  isSupportedLang,
  currencyOf,
  countriesForCurrency,
  resolveCountryPath,
  merchantInCountry,
} from '@loop/shared';

const merchant = (
  country?: string,
  currency?: string,
): Pick<Merchant, 'country' | 'denominations'> => ({
  country,
  denominations: currency ? { type: 'fixed', denominations: ['10'], currency } : undefined,
});

describe('COUNTRIES list integrity', () => {
  it('includes the anchor markets, the full Eurozone, and the extended markets', () => {
    expect(COUNTRIES).toHaveLength(28); // US + GB + CA + 20 Eurozone + 5 extended
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toContain('US');
    expect(codes).toContain('GB');
    expect(codes).toContain('CA');
    expect(codes).toContain('DE');
    // ADR 035 extended supplier-currency markets.
    expect(codes).toEqual(expect.arrayContaining(['AE', 'IN', 'SA', 'AU', 'MX']));
  });

  it('uses uppercase, unique ISO codes', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toEqual(codes.map((c) => c.toUpperCase()));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('only assigns supported display currencies', () => {
    for (const c of COUNTRIES) {
      expect(SUPPORTED_CURRENCIES).toContain(c.currency);
    }
  });

  it('puts the default country first in the catalogue', () => {
    expect(COUNTRIES[0]!.code).toBe(DEFAULT_COUNTRY);
  });
});

describe('currencyOf', () => {
  it('maps each anchor market to its currency', () => {
    expect(currencyOf('US')).toBe('USD');
    expect(currencyOf('GB')).toBe('GBP');
    expect(currencyOf('CA')).toBe('CAD');
    expect(currencyOf('DE')).toBe('EUR');
  });
  it('maps the extended markets to their currency (ADR 035)', () => {
    expect(currencyOf('AE')).toBe('AED');
    expect(currencyOf('IN')).toBe('INR');
    expect(currencyOf('SA')).toBe('SAR');
    expect(currencyOf('AU')).toBe('AUD');
    expect(currencyOf('MX')).toBe('MXN');
  });
  it('is case-insensitive', () => {
    expect(currencyOf('gb')).toBe('GBP');
  });
  it('returns undefined for an unrouted or empty code', () => {
    expect(currencyOf('JP')).toBeUndefined();
    expect(currencyOf(null)).toBeUndefined();
    expect(currencyOf('')).toBeUndefined();
  });
});

describe('countryByCode / isSupportedCountryCode / isSupportedLang', () => {
  it('looks up a country case-insensitively', () => {
    expect(countryByCode('de')?.label).toBe('Germany');
    expect(countryByCode('ZZ')).toBeUndefined();
    expect(countryByCode(null)).toBeUndefined();
  });
  it('recognises routed country codes', () => {
    expect(isSupportedCountryCode('fr')).toBe(true);
    expect(isSupportedCountryCode('JP')).toBe(false);
    expect(isSupportedCountryCode(null)).toBe(false);
  });
  it('recognises only English as a language segment for now', () => {
    expect(isSupportedLang('en')).toBe(true);
    expect(isSupportedLang('EN')).toBe(true);
    expect(isSupportedLang('de')).toBe(false);
    expect(isSupportedLang(null)).toBe(false);
  });
});

describe('countriesForCurrency', () => {
  it('returns the full Eurozone for EUR', () => {
    expect(countriesForCurrency('EUR')).toHaveLength(20);
  });
  it('returns a single country for the anchor currencies', () => {
    expect(countriesForCurrency('USD').map((c) => c.code)).toEqual(['US']);
    expect(countriesForCurrency('gbp').map((c) => c.code)).toEqual(['GB']);
  });
  it('returns a single country for each extended-market currency (ADR 035)', () => {
    expect(countriesForCurrency('AED').map((c) => c.code)).toEqual(['AE']);
    expect(countriesForCurrency('INR').map((c) => c.code)).toEqual(['IN']);
    expect(countriesForCurrency('mxn').map((c) => c.code)).toEqual(['MX']);
  });
});

describe('resolveCountryPath', () => {
  it('lowercases a routed country', () => {
    expect(resolveCountryPath('GB')).toBe('gb');
    expect(resolveCountryPath('de')).toBe('de');
  });
  it('falls back to the default for an unrouted / missing code', () => {
    expect(resolveCountryPath('JP')).toBe('us');
    expect(resolveCountryPath(null)).toBe('us');
    expect(resolveCountryPath('')).toBe('us');
  });
});

describe('merchantInCountry — ADR 034 visibility rule', () => {
  it('matches by explicit country', () => {
    expect(merchantInCountry(merchant('US', 'USD'), 'us')).toBe(true);
    expect(merchantInCountry(merchant('US', 'USD'), 'gb')).toBe(false);
  });

  it('surfaces a EUR merchant across every Eurozone country', () => {
    const frMerchant = merchant('FR', 'EUR');
    expect(merchantInCountry(frMerchant, 'fr')).toBe(true);
    expect(merchantInCountry(frMerchant, 'de')).toBe(true); // currency match
    expect(merchantInCountry(frMerchant, 'it')).toBe(true);
    expect(merchantInCountry(frMerchant, 'us')).toBe(false);
    expect(merchantInCountry(frMerchant, 'gb')).toBe(false);
  });

  it('matches a GBP merchant only in GB', () => {
    const gb = merchant('GB', 'GBP');
    expect(merchantInCountry(gb, 'gb')).toBe(true);
    expect(merchantInCountry(gb, 'de')).toBe(false);
  });

  it('is case-insensitive on the country argument', () => {
    expect(merchantInCountry(merchant('GB', 'GBP'), 'GB')).toBe(true);
  });

  it('matches by currency when the merchant has no country tag', () => {
    expect(merchantInCountry(merchant(undefined, 'EUR'), 'de')).toBe(true);
    expect(merchantInCountry(merchant(undefined, 'EUR'), 'us')).toBe(false);
  });

  it('matches by country when the merchant has no currency', () => {
    expect(merchantInCountry(merchant('DE', undefined), 'de')).toBe(true);
    expect(merchantInCountry(merchant('DE', undefined), 'fr')).toBe(false);
  });

  it('shows fully untagged merchants everywhere (data-gap fallback)', () => {
    const untagged = merchant(undefined, undefined);
    expect(merchantInCountry(untagged, 'us')).toBe(true);
    expect(merchantInCountry(untagged, 'de')).toBe(true);
  });
});
