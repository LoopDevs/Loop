import { describe, it, expect } from 'vitest';
import type { Merchant } from './merchants.js';
import { brandSlug, merchantSlug } from './slugs.js';

const m = (over: Partial<Merchant> & { name: string }): Merchant => ({
  id: over.id ?? over.name,
  enabled: true,
  ...over,
});

describe('brandSlug — country-agnostic brand key', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(brandSlug('Home Depot')).toBe('home-depot');
  });

  it('strips non-alphanumeric characters', () => {
    expect(brandSlug("Dunkin' Donuts")).toBe('dunkin-donuts');
  });

  it('drops unicode (ASCII-only output) — matches the CTX Go reference', () => {
    expect(brandSlug('Café')).toBe('caf');
    expect(brandSlug('Pokémon')).toBe('pokmon');
  });

  it('is the SAME across countries — that is the point for ADR 032 grouping', () => {
    // adidas in CA / US / GB all share ONE brand key, so they group into one tile.
    expect(brandSlug('adidas')).toBe('adidas');
    expect(brandSlug('adidas')).toBe(brandSlug('adidas'));
  });

  it('is idempotent — brandSlug(brandSlug(x)) === brandSlug(x)', () => {
    for (const input of ['Home Depot', "Dunkin' Donuts", '7-Eleven', 'dots.eco']) {
      const once = brandSlug(input);
      expect(brandSlug(once)).toBe(once);
    }
  });
});

describe('merchantSlug — country-aware, per-merchant', () => {
  describe('string overload (name-only call sites)', () => {
    it('is country-agnostic and equals brandSlug', () => {
      expect(merchantSlug('Home Depot')).toBe('home-depot');
      expect(merchantSlug('adidas')).toBe(brandSlug('adidas'));
    });
  });

  describe('1. prefers the CTX-provided slug', () => {
    it('uses CTX slug verbatim (already brand-country) over a derived value', () => {
      expect(merchantSlug(m({ name: 'adidas', country: 'CA', slug: 'adidas-ca' }))).toBe(
        'adidas-ca',
      );
    });

    it('sanitises a CTX slug through brandSlug for URL safety', () => {
      expect(merchantSlug(m({ name: 'Brand', country: 'US', slug: 'Brand_US!' }))).toBe('brandus');
    });

    it('falls through to derivation when the CTX slug is blank', () => {
      expect(merchantSlug(m({ name: 'adidas', country: 'CA', slug: '   ' }))).toBe('adidas-ca');
    });
  });

  describe('2. derives brand-country when CTX gives a country but no slug', () => {
    it('renamed form: "adidas" + CA → adidas-ca (clean)', () => {
      expect(merchantSlug(m({ name: 'adidas', country: 'CA' }))).toBe('adidas-ca');
    });

    it('transitional un-renamed form: "adidas Canada" + CA → adidas-canada-ca (unique, safe)', () => {
      expect(merchantSlug(m({ name: 'adidas Canada', country: 'CA' }))).toBe('adidas-canada-ca');
    });

    it('lowercases the country code', () => {
      expect(merchantSlug(m({ name: 'Tesco', country: 'GB' }))).toBe('tesco-gb');
    });
  });

  describe('3. data-gap fallback (no CTX slug, no country)', () => {
    it('falls back to a bare brand slug — preserves pre-country behaviour', () => {
      expect(merchantSlug(m({ name: 'Home Depot' }))).toBe('home-depot');
    });
  });

  describe('uniqueness per (brand, country) — the core invariant', () => {
    it('same brand across CA / US / GB → three distinct slugs, never a bare collision', () => {
      const ca = merchantSlug(m({ name: 'adidas', country: 'CA' }));
      const us = merchantSlug(m({ name: 'adidas', country: 'US' }));
      const gb = merchantSlug(m({ name: 'adidas', country: 'GB' }));
      expect(new Set([ca, us, gb]).size).toBe(3);
      expect([ca, us, gb]).not.toContain('adidas');
    });

    it('both name forms (renamed + un-renamed) stay unique per country', () => {
      // The CTX rename moves "adidas Canada" → "adidas"; both must remain unique.
      const renamed = merchantSlug(m({ name: 'adidas', country: 'CA' }));
      const transitional = merchantSlug(m({ name: 'adidas Canada', country: 'CA' }));
      expect(renamed).toBe('adidas-ca');
      expect(transitional).toBe('adidas-canada-ca');
      expect(renamed).not.toBe(transitional);
    });

    it('same brand + same country WITHOUT a CTX slug DOES collide (the true-dupe signal)', () => {
      // This is the only collision the sync warn should fire on.
      expect(merchantSlug(m({ id: 'a', name: 'lastminute', country: 'GB' }))).toBe(
        merchantSlug(m({ id: 'b', name: 'lastminute', country: 'GB' })),
      );
    });
  });
});
