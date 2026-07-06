/**
 * Deterministic per-merchant tile color for image FALLBACKS (media v2 plan A3).
 *
 * With most merchants still lacking a cover, every card fell back to the same
 * blue gradient — the directory read as "broken/placeholder" rather than
 * "intentionally minimal". A stable color derived from the merchant name gives
 * each uncovered merchant a distinct, recognisable tile, so the grid looks
 * designed at any coverage. Zero data cost (computed from the name).
 *
 * Constrained saturation/lightness keeps it on-brand (the clean-tech cool
 * palette) rather than a garish full-spectrum HSL, and dark enough for white
 * text/monogram to sit legibly on top.
 */
import type { CSSProperties } from 'react';

/** Stable 0–359 hue from a name (FNV-ish rolling hash). */
export function brandHue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** Inline style for a fallback tile: a subtle two-stop gradient in the
 *  merchant's hue, muted + on the darker side so white text reads. */
export function brandTileStyle(name: string): CSSProperties {
  const h = brandHue(name);
  return {
    backgroundImage: `linear-gradient(135deg, hsl(${h} 34% 46%), hsl(${h} 40% 32%))`,
  };
}
