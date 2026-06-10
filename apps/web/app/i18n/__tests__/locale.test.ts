/** ADR 034 Phase 1 — Intl formatting seam + `t()` message lookup. */
import { describe, it, expect } from 'vitest';
import { localeTag, formatCurrency, currencySymbol, formatNumber } from '../format.js';
import { t } from '../t.js';
import type { MessageKey } from '../messages.js';

describe('localeTag', () => {
  it('builds a BCP-47 tag from lang + country', () => {
    expect(localeTag('en', 'gb')).toBe('en-GB');
    expect(localeTag('en', 'US')).toBe('en-US');
    expect(localeTag('EN', 'de')).toBe('en-DE');
  });
  it('falls back to the default language and drops an empty country', () => {
    expect(localeTag('', '')).toBe('en');
    expect(localeTag('en', '')).toBe('en');
  });
});

describe('formatCurrency', () => {
  it('formats in the locale + currency', () => {
    const gbp = formatCurrency(10, 'GBP', 'en-GB');
    expect(gbp).toContain('£');
    expect(gbp).toContain('10');
    const eur = formatCurrency(10, 'EUR', 'de-DE');
    expect(eur).toContain('€');
  });
  it('falls back to a readable string on an unknown currency', () => {
    expect(formatCurrency(1.23, 'XYZ' + 'Z')).toBe('1.23 XYZZ');
  });
});

describe('currencySymbol', () => {
  it('returns the narrow symbol per currency', () => {
    expect(currencySymbol('GBP')).toBe('£');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('USD')).toBe('$');
  });
  it('falls back to $ on an unknown code', () => {
    expect(currencySymbol('XYZ' + 'Z')).toBe('$');
  });
});

describe('formatNumber', () => {
  it('groups thousands per locale', () => {
    expect(formatNumber(1234.5, 'en-US')).toBe('1,234.5');
  });
});

describe('t', () => {
  it('returns a plain message', () => {
    expect(t('home.cta.start')).toBe("Get started — it's free");
  });
  it('interpolates placeholders', () => {
    expect(t('merchant.savings', { percent: 5 })).toBe('5% off');
  });
  it('leaves an unmatched placeholder intact', () => {
    expect(t('home.hero.subtitle')).toContain('{inCountry}');
  });
  it('falls back to English for an unknown language', () => {
    expect(t('home.cta.start', undefined, 'de')).toBe("Get started — it's free");
  });
  it('returns the key itself for an unknown key (debuggable fallback)', () => {
    expect(t('not.a.real.key' as MessageKey)).toBe('not.a.real.key');
  });
});
