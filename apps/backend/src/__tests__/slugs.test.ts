import { describe, it, expect } from 'vitest';
import { merchantSlug } from '@loop/shared';

describe('merchantSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(merchantSlug('Home Depot')).toBe('home-depot');
  });

  it('strips non-alphanumeric characters', () => {
    expect(merchantSlug("Dunkin' Donuts")).toBe('dunkin-donuts');
  });

  it('collapses runs of whitespace into a single hyphen', () => {
    expect(merchantSlug('Some   Store')).toBe('some-store');
  });

  it('handles tabs and newlines as whitespace', () => {
    expect(merchantSlug('Some\tStore')).toBe('some-store');
    expect(merchantSlug('Some\nStore')).toBe('some-store');
  });

  it('returns empty string for empty input', () => {
    expect(merchantSlug('')).toBe('');
  });

  it('preserves numbers', () => {
    expect(merchantSlug('7-Eleven')).toBe('7-eleven');
  });

  it('leaves already-lowercase input untouched', () => {
    expect(merchantSlug('target')).toBe('target');
  });

  // Non-ASCII handling: matches the Go reference on upstream CTX — characters
  // outside [a-z0-9-] are dropped rather than transliterated. Anything that
  // needs Unicode support has to normalise upstream.
  it('drops unicode characters (ASCII-only output)', () => {
    expect(merchantSlug('Café')).toBe('caf');
    expect(merchantSlug('Pokémon')).toBe('pokmon');
  });

  it('always produces a string matching [a-z0-9-]*', () => {
    const inputs = [
      'Foo!@#$%Bar',
      '  Spaces  ',
      '--leading--',
      'UPPER!CASE_With_Underscores',
      '日本語',
      'Price: $9.99',
    ];
    for (const input of inputs) {
      expect(merchantSlug(input)).toMatch(/^[a-z0-9-]*$/);
    }
  });

  // Documented behaviour: leading/trailing whitespace becomes leading/trailing
  // hyphens. We don't trim because the Go reference doesn't either, and
  // changing it would break every cached slug on clients and in the backend
  // store. Upstream merchant names don't currently have leading/trailing
  // whitespace; this test pins the behaviour so any change is deliberate.
  it('does not trim leading/trailing hyphens produced by whitespace', () => {
    expect(merchantSlug(' Home Depot ')).toBe('-home-depot-');
    expect(merchantSlug('Home Depot ')).toBe('home-depot-');
  });

  // Idempotency: a slug fed back through the function should be stable. This
  // matters because we sometimes canonicalise values defensively; if the
  // function weren't idempotent, repeated canonicalisation would drift.
  it('is idempotent — slug(slug(x)) === slug(x)', () => {
    const inputs = ['Home Depot', "Dunkin' Donuts", '7-Eleven', 'Some   Store', 'UPPER CASE', ''];
    for (const input of inputs) {
      const once = merchantSlug(input);
      const twice = merchantSlug(once);
      expect(twice).toBe(once);
    }
  });
});
