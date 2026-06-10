/** ADR 034 Phase 2 — locale normalisation + link prefixing. */
import { describe, it, expect } from 'vitest';
import { normalizeLocale, localizedHref, DEFAULT_LOCALE } from '../locale.js';

describe('normalizeLocale', () => {
  it('lowercases routed segments', () => {
    expect(normalizeLocale('GB', 'EN')).toEqual({ country: 'gb', lang: 'en' });
    expect(normalizeLocale('de', 'en')).toEqual({ country: 'de', lang: 'en' });
  });
  it('falls back to the default market for unrouted segments', () => {
    expect(normalizeLocale('zz', 'en')).toEqual(DEFAULT_LOCALE);
    expect(normalizeLocale('gb', 'de')).toEqual({ country: 'gb', lang: 'en' });
    expect(normalizeLocale(undefined, undefined)).toEqual(DEFAULT_LOCALE);
    expect(normalizeLocale(null, null)).toEqual(DEFAULT_LOCALE);
  });
});

describe('localizedHref', () => {
  const gb = { country: 'gb', lang: 'en' };

  it('prefixes a plain path', () => {
    expect(localizedHref('/cashback', gb)).toBe('/gb/en/cashback');
    expect(localizedHref('cashback', gb)).toBe('/gb/en/cashback');
  });
  it('maps the root path to the locale home', () => {
    expect(localizedHref('/', gb)).toBe('/gb/en');
    expect(localizedHref('', gb)).toBe('/gb/en');
  });
  it('preserves query and hash', () => {
    expect(localizedHref('/cashback?q=x#top', gb)).toBe('/gb/en/cashback?q=x#top');
  });
  it('is idempotent — re-points an already-prefixed path, never doubles it', () => {
    expect(localizedHref('/us/en/cashback', gb)).toBe('/gb/en/cashback');
    expect(localizedHref('/gb/en', gb)).toBe('/gb/en');
  });
  it('does not mistake a deep path segment for a locale prefix', () => {
    // `/gift-card/...` must not be treated as a `gi/ft` locale.
    expect(localizedHref('/gift-card/aerie', gb)).toBe('/gb/en/gift-card/aerie');
    expect(localizedHref('/map', gb)).toBe('/gb/en/map');
  });
});
