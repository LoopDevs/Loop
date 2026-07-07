import { describe, it, expect } from 'vitest';
import {
  localeTag,
  formatCurrency,
  formatMoney,
  currencySymbol,
  formatNumber,
  formatMinorCurrency,
} from '../format';

describe('localeTag', () => {
  it('joins language + country into a normalised BCP-47 tag', () => {
    expect(localeTag('en', 'gb')).toBe('en-GB');
    expect(localeTag('EN', 'Gb')).toBe('en-GB'); // lower lang, upper country
  });

  it('drops the country segment when it is absent', () => {
    expect(localeTag('de', '')).toBe('de');
  });

  it('falls back to the default language when lang is empty', () => {
    expect(localeTag('', 'US')).toMatch(/^[a-z]{2}-US$/);
  });
});

describe('formatCurrency', () => {
  it('formats with the locale currency symbol', () => {
    expect(formatCurrency(25, 'USD', 'en-US')).toBe('$25.00');
  });

  it('formats a well-formed but unknown ISO code using the code itself', () => {
    const s = formatCurrency(1.23, 'XYZ', 'en-US');
    expect(s).toContain('1.23');
    expect(s).toContain('XYZ');
  });

  it('falls back to "amount CODE" on a MALFORMED code instead of throwing', () => {
    expect(formatCurrency(1.23, 'XY', 'en-US')).toBe('1.23 XY');
  });
});

describe('formatMoney', () => {
  it('renders the ISO code (not a symbol) alongside the amount', () => {
    const s = formatMoney(25, 'EUR', 'en-US');
    expect(s).toContain('EUR');
    expect(s).toContain('25.00');
  });

  it('falls back to "amount CODE" on a malformed code', () => {
    expect(formatMoney(25, 'XY', 'en-US')).toBe('25.00 XY');
  });
});

describe('currencySymbol', () => {
  it('returns the narrow symbol for the locale', () => {
    expect(currencySymbol('USD', 'en-US')).toBe('$');
    expect(currencySymbol('GBP', 'en-GB')).toBe('£');
  });

  it('falls back to "$" on a malformed code', () => {
    expect(currencySymbol('XY')).toBe('$');
  });
});

describe('formatNumber', () => {
  it('adds locale thousands separators', () => {
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
  });
});

describe('formatMinorCurrency', () => {
  it('renders bigint minor units as a localised currency string', () => {
    const s = formatMinorCurrency(250000n, 'USD', 'en-US'); // 250000 cents → $2,500.00
    expect(s).toContain('2,500');
    expect(s).toContain('$');
  });

  it('accepts string and number minor inputs too', () => {
    expect(formatMinorCurrency('250000', 'USD', 'en-US')).toContain('2,500');
    expect(formatMinorCurrency(250000, 'USD', 'en-US')).toContain('2,500');
  });
});
