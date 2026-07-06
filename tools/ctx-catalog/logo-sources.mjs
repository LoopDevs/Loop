#!/usr/bin/env node
/**
 * logo-sources.mjs — logo source URL builders + cover-reject heuristics (media
 * v2 plan S3, the explicit fallback ladder).
 *
 * Two concrete fixes over the old ad-hoc sourcing:
 *
 *  1. `logoDevUrl()` always sets `fallback=404`. Without it, a logo.dev MISS
 *     returns a generic monogram — which is a valid 200 response, gets saved as
 *     a "logo", and then needs a whole sharp+vision QC round to reject. With
 *     `fallback=404` a miss is an explicit, cheap 404 the fetcher records as a
 *     clean gap, so the fallback ladder (brand.dev → scrape → monogram) can take
 *     over instead of shipping junk.
 *
 *  2. `looksLikeFaceplate()` rejects supplier gift-card faceplate / voucher art
 *     masquerading as a cover — a cover should be a real scene, not a picture of
 *     the card itself.
 *
 * brand.dev is the documented next rung of the ladder; wiring its live call
 * needs a `BRAND_DEV_KEY` + endpoint details (follow-up) — this module is where
 * that builder slots in.
 *
 * API:
 *   logoDevUrl(domain, { token, size?, format?, retina? }) → string
 *   looksLikeFaceplate(text) → boolean
 *
 * CLI: node logo-sources.mjs --self-test
 */
import { fileURLToPath } from 'node:url';

export function logoDevUrl(domain, { token = '', size = 400, format = 'png', retina = true } = {}) {
  const params = new URLSearchParams({ token, size: String(size), format });
  if (retina) params.set('retina', 'true');
  params.set('fallback', '404'); // a miss = explicit 404, not a junk monogram
  return `https://img.logo.dev/${encodeURIComponent(domain)}?${params.toString()}`;
}

// Supplier gift-card faceplates / voucher art that keep getting sourced as
// "covers". A cover must be a real storefront/lifestyle scene.
export const FACEPLATE = /gift\s?-?card|voucher|e-?gift|faceplate|card\s?front|denomination/i;
export function looksLikeFaceplate(text) {
  return FACEPLATE.test(text || '');
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const url = logoDevUrl('tesco.co.uk', { token: 'pk_x', size: 512 });
  const checks = {
    'logoDevUrl always sets fallback=404': url.includes('fallback=404'),
    'logoDevUrl carries domain + token + size':
      url.includes('tesco.co.uk') && url.includes('token=pk_x') && url.includes('size=512'),
    'faceplate: "Aerie gift card front" → rejected':
      looksLikeFaceplate('Aerie gift card front') === true,
    'faceplate: "Tesco voucher" → rejected': looksLikeFaceplate('a Tesco voucher') === true,
    'faceplate: a real scene → kept':
      looksLikeFaceplate('Wickes DIY store interior, aisles of paint') === false,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain) {
  console.log('usage: logo-sources.mjs --self-test');
}
