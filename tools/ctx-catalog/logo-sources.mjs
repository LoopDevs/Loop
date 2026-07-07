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
 *   logoSourceQuality(url) → 'ok' | 'aggregator' | 'icon-library' | 'reseller-portal' | 'placeholder'
 *
 * CLI: node logo-sources.mjs --self-test
 */
import { fileURLToPath } from 'node:url';
import { getDomainWithoutSuffix } from 'tldts';

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

// A logo URL hosted on one of these is NOT the brand's real logo: aggregators
// scrape mixed-quality marks, icon libraries hand back monochrome simplified
// glyphs, reseller/portal sites host card art, and avatar generators emit
// monograms. Auditing the recovered data, ~100+ sourced logos came from these.
// logoSourceQuality classifies by registrable SLD so the sourcing/QC step can
// flag them for RE-SOURCING cheaply (no fetch) — prevention over a fetch+vision
// round. Matched on the SLD so any TLD/subdomain variant is covered.
const LOGO_SOURCE_CLASSES = {
  aggregator: [
    'seeklogo',
    '1000logos',
    'logowik',
    'logodownload',
    'brandsoftheworld',
    'freebiesupply',
    'wikimedia',
    'wikipedia',
    'logolynx',
    'logospng',
  ],
  'icon-library': ['iconify', 'simpleicons', 'icons8', 'flaticon'],
  'reseller-portal': ['gyft', 'egifter', 'townandcitygiftcards', 'giftcards', 'gcodes'],
  placeholder: ['uiavatars', 'gravatar', 'placeholder'],
};

export function logoSourceQuality(url) {
  const sld = (getDomainWithoutSuffix(url) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!sld) return 'ok';
  for (const [cls, slds] of Object.entries(LOGO_SOURCE_CLASSES)) {
    if (slds.includes(sld)) return cls;
  }
  return 'ok';
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
    'logoSourceQuality: seeklogo → aggregator':
      logoSourceQuality('https://seeklogo.com/images/x.png') === 'aggregator',
    'logoSourceQuality: iconify → icon-library':
      logoSourceQuality('https://api.iconify.design/mdi/x.svg') === 'icon-library',
    'logoSourceQuality: gyft → reseller-portal':
      logoSourceQuality('https://www.gyft.com/x') === 'reseller-portal',
    'logoSourceQuality: ui-avatars → placeholder':
      logoSourceQuality('https://ui-avatars.com/api/?name=X') === 'placeholder',
    'logoSourceQuality: logo.dev + brand domain → ok':
      logoSourceQuality('https://img.logo.dev/tesco.com') === 'ok' &&
      logoSourceQuality('https://www.tesco.com/logo.png') === 'ok',
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain) {
  console.log('usage: logo-sources.mjs --self-test');
}
