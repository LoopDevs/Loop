/**
 * ADR 034 Phase 1 — Intl formatting seam.
 *
 * The `t()` message-lookup tests that used to live here (against the
 * hand-rolled `t.ts`/`messages.ts` PHASE-2 SCAFFOLD) moved to
 * `../__tests__/i18next.test.tsx` — ADR 043 (B-6) replaced that scaffold
 * with i18next/react-i18next; `t.ts`/`messages.ts` are deleted (they were
 * imported by nobody — see ADR 043's "supersedes" note).
 */
import { describe, it, expect } from 'vitest';
import {
  localeTag,
  formatCurrency,
  formatMoney,
  formatMinorCurrency,
  currencySymbol,
  formatNumber,
} from '../format.js';

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

describe('formatMoney', () => {
  it('formats with the ISO code, not a hardcoded dollar sign (A-029 regression)', () => {
    const usd = formatMoney(25, 'USD');
    expect(usd).toContain('USD');
    expect(usd).toContain('25.00');
    const eur = formatMoney(25, 'EUR');
    expect(eur).toContain('EUR');
    expect(eur).not.toMatch(/^\$/);
  });
  it('honours the passed locale for separators', () => {
    // de-DE uses a comma decimal separator.
    expect(formatMoney(1234.5, 'EUR', 'de-DE')).toContain('1.234,50');
  });
  it('falls back to a plain "amount code" rendering for unknown currencies', () => {
    expect(formatMoney(1.5, 'NOTREAL')).toBe('1.50 NOTREAL');
  });
});

describe('formatMinorCurrency (locale-threaded web wrapper)', () => {
  it('formats minor units in the passed route locale', () => {
    const gbp = formatMinorCurrency('12345', 'GBP', 'en-GB');
    expect(gbp).toContain('£');
    expect(gbp).toContain('123.45');
  });
  it('defaults to en-US when no locale is passed (stable for direct callers)', () => {
    expect(formatMinorCurrency('12345', 'USD')).toBe('$123.45');
  });
  it('supports the 0-decimal summary variant', () => {
    expect(formatMinorCurrency('35000', 'USD', 'en-US', { fractionDigits: 0 })).toBe('$350');
  });
});
