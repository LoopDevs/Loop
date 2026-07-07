import { describe, it, expect } from 'vitest';
import { brandHue, brandTileStyle } from '../brand-color';

describe('brandHue', () => {
  it('is deterministic — same name always yields the same hue', () => {
    expect(brandHue('Aerie')).toBe(brandHue('Aerie'));
    expect(brandHue('Some Long Merchant Name')).toBe(brandHue('Some Long Merchant Name'));
  });

  it('returns an integer hue in [0, 360) for every input', () => {
    for (const n of ['Aerie', 'Tesco', 'Amazon', '', 'a', '1-800-Flowers', '日本語ブランド']) {
      const h = brandHue(n);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('pins known values so a silent change to the hash is caught', () => {
    expect(brandHue('Aerie')).toBe(225);
    expect(brandHue('Tesco')).toBe(141);
    expect(brandHue('Amazon')).toBe(93);
    // empty name → the FNV offset basis reduced mod 360, still a valid hue
    expect(brandHue('')).toBe(61);
  });

  it('is case-sensitive so near-identical names get distinct tiles', () => {
    expect(brandHue('a')).not.toBe(brandHue('A'));
  });

  it('spreads hues across the wheel (not clustered) over many names', () => {
    const hues = new Set(Array.from({ length: 100 }, (_, i) => brandHue(`Brand${i}`)));
    expect(hues.size).toBeGreaterThan(80); // 92 in practice
  });
});

describe('brandTileStyle', () => {
  it('embeds the name hue in a two-stop gradient and is deterministic', () => {
    const h = brandHue('Aerie');
    const style = brandTileStyle('Aerie');
    expect(style.backgroundImage).toContain('linear-gradient(135deg');
    expect(style.backgroundImage).toContain(`hsl(${h} 34% 46%)`);
    expect(style.backgroundImage).toContain(`hsl(${h} 40% 32%)`);
    expect(brandTileStyle('Aerie')).toEqual(brandTileStyle('Aerie'));
  });

  it('gives different merchants visually different tiles', () => {
    expect(brandTileStyle('Aerie').backgroundImage).not.toBe(
      brandTileStyle('Tesco').backgroundImage,
    );
  });
});
