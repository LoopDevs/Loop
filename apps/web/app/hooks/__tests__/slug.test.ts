import { describe, it, expect } from 'vitest';
import { toSlug } from '../slug';

describe('toSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(toSlug('Home Depot')).toBe('home-depot');
  });

  it('strips non-alphanumeric characters', () => {
    expect(toSlug("Dunkin' Donuts")).toBe('dunkin-donuts');
  });

  it('handles multiple consecutive spaces', () => {
    expect(toSlug('Some   Store')).toBe('some-store');
  });

  it('returns empty string for empty input', () => {
    expect(toSlug('')).toBe('');
  });

  it('encodes special characters for URL safety', () => {
    expect(toSlug('7-Eleven')).toBe('7-eleven');
  });
});
