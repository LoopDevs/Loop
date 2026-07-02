import { describe, expect, it } from 'vitest';

import { foldForSearch } from './search.js';

describe('foldForSearch', () => {
  it('lowercases', () => {
    expect(foldForSearch('DUNKIN')).toBe('dunkin');
  });

  it('strips combining diacritics so "cafe" matches "Café"', () => {
    expect(foldForSearch('Café')).toBe('cafe');
    expect(foldForSearch('Beyoncé')).toBe('beyonce');
    expect(foldForSearch('Müller')).toBe('muller');
    expect(foldForSearch('Señor')).toBe('senor');
  });

  it('handles precomposed and decomposed forms identically', () => {
    const precomposed = 'Café'; // é as single code point
    const decomposed = 'Café'; // e + combining acute
    expect(foldForSearch(precomposed)).toBe(foldForSearch(decomposed));
  });

  it('leaves ASCII punctuation and digits alone', () => {
    expect(foldForSearch("Dunkin' Donuts 24/7")).toBe("dunkin' donuts 24/7");
  });

  it('is idempotent', () => {
    const once = foldForSearch('Crème Brûlée');
    expect(foldForSearch(once)).toBe(once);
  });
});
