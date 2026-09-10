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

  // Non-ASCII: dropped rather than transliterated to match Go reference.
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

  // Leading/trailing whitespace becomes hyphens; not trimmed to match Go reference.
  it('does not trim leading/trailing hyphens produced by whitespace', () => {
    expect(merchantSlug(' Home Depot ')).toBe('-home-depot-');
    expect(merchantSlug('Home Depot ')).toBe('home-depot-');
  });

  // Idempotency: repeated canonicalisation must not drift.
  it('is idempotent — slug(slug(x)) === slug(x)', () => {
    const inputs = ['Home Depot', "Dunkin' Donuts", '7-Eleven', 'Some   Store', 'UPPER CASE', ''];
    for (const input of inputs) {
      const once = merchantSlug(input);
      const twice = merchantSlug(once);
      expect(twice).toBe(once);
    }
  });
});
