import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REGION,
  EUROZONE_COUNTRIES,
  REGIONS,
  REGION_CODES,
  isSupportedCountry,
  regionByCode,
  regionForCountry,
} from './regions.js';

describe('regionForCountry', () => {
  it('maps each region country to its region', () => {
    expect(regionForCountry('US')).toBe('US');
    expect(regionForCountry('CA')).toBe('CA');
    expect(regionForCountry('GB')).toBe('UK');
    for (const c of EUROZONE_COUNTRIES) expect(regionForCountry(c)).toBe('EUR');
  });

  it('is case-insensitive', () => {
    expect(regionForCountry('gb')).toBe('UK');
    expect(regionForCountry('de')).toBe('EUR');
  });

  it('falls back to DEFAULT_REGION for unknown / null / undefined / empty', () => {
    expect(regionForCountry('JP')).toBe(DEFAULT_REGION);
    expect(regionForCountry(null)).toBe(DEFAULT_REGION);
    expect(regionForCountry(undefined)).toBe(DEFAULT_REGION);
    expect(regionForCountry('')).toBe(DEFAULT_REGION);
  });
});

describe('regionByCode', () => {
  it('resolves every declared region code', () => {
    for (const code of REGION_CODES) expect(regionByCode(code).code).toBe(code);
  });

  it('falls back to US for unknown / null', () => {
    expect(regionByCode('XX').code).toBe('US');
    expect(regionByCode(null).code).toBe('US');
    expect(regionByCode(undefined).code).toBe('US');
  });
});

describe('isSupportedCountry', () => {
  it('accepts covered countries in any case, rejects the rest', () => {
    expect(isSupportedCountry('US')).toBe(true);
    expect(isSupportedCountry('fr')).toBe(true);
    expect(isSupportedCountry('JP')).toBe(false);
    expect(isSupportedCountry(null)).toBe(false);
    expect(isSupportedCountry(undefined)).toBe(false);
    expect(isSupportedCountry('')).toBe(false);
  });
});

describe('region model consistency', () => {
  it('every region declares at least one country and a currency symbol', () => {
    for (const r of REGIONS) {
      expect(r.countries.length).toBeGreaterThan(0);
      expect(r.currencySymbol.length).toBeGreaterThan(0);
    }
  });

  it('no country appears in two regions', () => {
    const all = REGIONS.flatMap((r) => [...r.countries]);
    expect(new Set(all).size).toBe(all.length);
  });
});
