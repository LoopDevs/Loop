/** ADR 034 Phase 2/3 — locale normalisation, link prefixing, country cookie. */
import { describe, it, expect } from 'vitest';
import {
  normalizeLocale,
  localizedHref,
  stripLocale,
  isLocalizablePath,
  parseCountryCookie,
  DEFAULT_LOCALE,
} from '../locale.js';

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

describe('stripLocale', () => {
  it('removes a leading locale prefix', () => {
    expect(stripLocale('/gb/en/cashback')).toBe('/cashback');
    expect(stripLocale('/us/en')).toBe('/');
  });
  it('is a no-op on an unprefixed path', () => {
    expect(stripLocale('/cashback')).toBe('/cashback');
    expect(stripLocale('/gift-card/aerie')).toBe('/gift-card/aerie');
  });
});

describe('isLocalizablePath', () => {
  it('is true for the public catalogue + onboarding (prefixed or not)', () => {
    expect(isLocalizablePath('/')).toBe(true);
    expect(isLocalizablePath('/cashback')).toBe(true);
    expect(isLocalizablePath('/gb/en/cashback')).toBe(true);
    expect(isLocalizablePath('/gift-card/aerie')).toBe(true);
    expect(isLocalizablePath('/onboarding')).toBe(true);
  });
  it('is false for app + admin routes (no localized mount)', () => {
    expect(isLocalizablePath('/orders')).toBe(false);
    expect(isLocalizablePath('/settings/wallet')).toBe(false);
    expect(isLocalizablePath('/admin/users')).toBe(false);
    expect(isLocalizablePath('/auth')).toBe(false);
  });
});

describe('parseCountryCookie', () => {
  it('extracts a routed country from a Cookie header', () => {
    expect(parseCountryCookie('loop_country=gb')).toBe('gb');
    expect(parseCountryCookie('a=1; loop_country=DE; b=2')).toBe('de');
  });
  it('ignores an absent / unrouted / empty cookie', () => {
    expect(parseCountryCookie('loop_country=zz')).toBeNull();
    expect(parseCountryCookie('other=1')).toBeNull();
    expect(parseCountryCookie('')).toBeNull();
    expect(parseCountryCookie(null)).toBeNull();
  });
});
