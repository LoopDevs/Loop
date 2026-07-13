import { describe, it, expect } from 'vitest';
import {
  localeTag,
  formatCurrency,
  formatMoney,
  currencySymbol,
  formatNumber,
  formatMinorCurrency,
  formatDateTime,
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

describe('formatDateTime', () => {
  // The whole point of this seam is that the LOCALE drives the output, not the
  // host default. `timeZone: 'UTC'` pins the instant so the assertion is
  // deterministic on any CI box, and `{ day, month: 'long' }` is a shape whose
  // ORDER differs by locale: German is day-first ("20. April"), English is
  // month-first ("April 20"). Same instant + same options → different string
  // purely because the locale differs, which is exactly the contract.
  it('renders the instant in the given locale, not the host default', () => {
    const iso = '2026-04-20T12:00:00.000Z';
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', timeZone: 'UTC' };
    expect(formatDateTime(iso, 'de-DE', opts)).toBe('20. April');
    expect(formatDateTime(iso, 'en-US', opts)).toBe('April 20');
  });

  it('threads the caller options through (short date + 24h time under en-GB)', () => {
    const iso = '2026-04-20T09:05:00.000Z';
    expect(
      formatDateTime(iso, 'en-GB', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }),
    ).toBe('20 Apr, 09:05');
  });

  it('degrades to the raw ISO string on a malformed locale tag instead of throwing', () => {
    const iso = '2026-04-20T12:00:00.000Z';
    expect(formatDateTime(iso, 'bad locale!')).toBe(iso);
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
