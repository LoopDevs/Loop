#!/usr/bin/env node
/**
 * domain-tools.mjs — confidence-scored domain resolution (media v2 plan S1, ADR 041).
 *
 * Domain resolution is the sourcing keystone: a wrong domain silently poisons
 * the logo (logo.dev key), the cover (brand-owned detection), AND the redeem
 * instructions. Two fixes over the old ad-hoc `rootOf` (`.split('.').slice(-2)`):
 *
 *  1. `registrable()` — the eTLD+1 via the Public Suffix List (tldts), so
 *     `tesco.co.uk` → `tesco.co.uk` (not `co.uk`) and `harveynorman.com.au` →
 *     `harveynorman.com.au`. The old last-2-labels was wrong for every ccTLD SLD
 *     — exactly the GB/AU/MX markets we're expanding into.
 *  2. `scoreCandidate()` / `resolveDomain()` — a deterministic confidence score
 *     with a hard deny-list (marketplaces / gift-card resellers / socials / wikis
 *     / logo aggregators can NEVER be a brand's own domain). Auto-accept ≥ 0.8;
 *     the rest go to `domain-review-server`. This is what cuts the per-miss human
 *     review cost — instead of pushing every candidate to a person.
 *
 * API:
 *   registrable(urlOrDomain) → 'tesco.co.uk' | null
 *   isDeniedDomain(urlOrDomain) → boolean
 *   scoreCandidate(candidate, { name, country }) → { domain, confidence, reasons }
 *   resolveDomain({ name, country }, candidates[]) → { domain, confidence, reasons, autoAccept, alternatives }
 *
 * CLI:
 *   node domain-tools.mjs --self-test
 *   node domain-tools.mjs --resolve "Aerie" US ae.com aerie.com freefirepro.com
 */
import { getDomain, getDomainWithoutSuffix } from 'tldts';
import { fileURLToPath } from 'node:url';

/** eTLD+1 via the Public Suffix List. Accepts a URL or a bare host. */
export function registrable(input) {
  if (!input || typeof input !== 'string') return null;
  return getDomain(input) || null;
}

// A brand's own storefront is NEVER one of these — they're where OTHER brands'
// cards get resold/listed/discussed. Matched on the registrable SLD so
// `apps.apple.com`-style subdomains and any TLD variant are covered.
const DENY_SLDS = new Set([
  // marketplaces
  'amazon',
  'ebay',
  'walmart',
  'etsy',
  'aliexpress',
  'alibaba',
  'wish',
  'temu',
  'rakuten',
  'mercadolibre',
  'target',
  'bestbuy',
  // gift-card resellers / key shops
  'eneba',
  'kinguin',
  'g2a',
  'g2play',
  'gamivo',
  'cdkeys',
  'cardcash',
  'raise',
  'dundle',
  'gcodes',
  'gameflip',
  'eldorado',
  'giftcards',
  'cardpool',
  // gift-card / loyalty INFRASTRUCTURE — the suppliers + processors whose
  // redemption-portal URLs show up in supplier `redeemUrl`/terms fields but are
  // NEVER a brand's own storefront (anchoring a merchant to these was the risk).
  'tillo',
  'blackhawk',
  'bhnetwork',
  'cashstar',
  'wgiftcard',
  'ezpin',
  'incomm',
  'qwikcilver',
  'woohoo',
  'storedvalue',
  // socials / UGC
  'facebook',
  'instagram',
  'twitter',
  'x',
  'tiktok',
  'linkedin',
  'pinterest',
  'youtube',
  'reddit',
  'snapchat',
  'tumblr',
  // wikis / reference
  'wikipedia',
  'wikimedia',
  'fandom',
  'wikidata',
  // logo aggregators / stock
  'logo',
  'clearbit',
  'brandfetch',
  'seeklogo',
  'logowik',
  'logodownload',
  '1000logos',
  'freebiesupply',
  'brandsoftheworld',
]);

export function isDeniedDomain(input) {
  const sld = getDomainWithoutSuffix(input);
  return sld ? DENY_SLDS.has(sld.toLowerCase().replace(/[^a-z0-9]/g, '')) : false;
}

const CC_TLD = {
  GB: '.uk',
  AU: '.au',
  MX: '.mx',
  IN: '.in',
  CA: '.ca',
  DE: '.de',
  FR: '.fr',
  ES: '.es',
  IT: '.it',
  NL: '.nl',
  AE: '.ae',
  SA: '.sa',
  IE: '.ie',
  NZ: '.nz',
};

const normBrand = (name) =>
  (name || '')
    .toLowerCase()
    .replace(
      /\s+(us|usa|uk|gb|canada|ca|europe|eu|au|australia|mx|mexico|in|india|ae|uae|sa|ie|nz)$/i,
      '',
    )
    .replace(/[^a-z0-9]/g, '');

/**
 * Score one candidate against the brand brief. Denied hosts hard-zero; otherwise
 * the score rises with how closely the registrable SLD matches the brand name,
 * plus a small bonus for the country's ccTLD storefront.
 *
 * `supplierAnchored`: the URL came from the supplier's OWN record for this
 * merchant (a website field, or extracted from the redemption/terms copy). That
 * is authoritative identity — trust it over name-matching, which is exactly what
 * fixes the wrong-brand error (e.g. "Aerie" → `ae.com`, where the SLD doesn't
 * match the name at all). Still subject to the deny-list above, so a reseller
 * URL in the text can't sneak through.
 */
export function scoreCandidate(candidate, { name, country, supplierAnchored } = {}) {
  const domain = registrable(candidate);
  if (!domain) return { domain: null, confidence: 0, reasons: ['unresolvable'] };
  if (isDeniedDomain(candidate))
    return { domain, confidence: 0, reasons: ['denied:marketplace/reseller/social'] };

  const reasons = [];
  const sld = (getDomainWithoutSuffix(candidate) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const brand = normBrand(name);
  let conf = 0.3;
  if (brand && sld) {
    if (sld === brand) {
      conf = 0.95;
      reasons.push('exact-name');
    } else if (sld.includes(brand) || brand.includes(sld)) {
      conf = 0.8;
      reasons.push('name-substring');
    } else {
      reasons.push('weak-name-match');
    }
  } else {
    reasons.push('no-brand-name');
  }
  const cc = country && CC_TLD[country];
  if (cc && domain.endsWith(cc)) {
    conf = Math.min(0.99, conf + 0.05);
    reasons.push(`cc:${country}`);
  }
  if (supplierAnchored) {
    conf = Math.max(conf, 0.9);
    reasons.push('supplier-anchored');
  }
  return { domain, confidence: Number(conf.toFixed(2)), reasons };
}

/** Pick the best candidate; auto-accept at ≥ 0.8, else route to human review. */
export function resolveDomain(brief, candidates = []) {
  const scored = candidates
    .map((c) => scoreCandidate(c, brief))
    .filter((s) => s.domain)
    .sort((a, b) => b.confidence - a.confidence);
  const best = scored[0] || { domain: null, confidence: 0, reasons: ['no-candidates'] };
  return { ...best, autoAccept: best.confidence >= 0.8, alternatives: scored.slice(1, 3) };
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
if (isMain && argv.includes('--self-test')) {
  const checks = {
    'PSL root: tesco.co.uk (not co.uk)': registrable('https://www.tesco.co.uk/x') === 'tesco.co.uk',
    'PSL root: harveynorman.com.au': registrable('harveynorman.com.au') === 'harveynorman.com.au',
    'PSL root: strips www + path': registrable('http://www.aerie.com/women') === 'aerie.com',
    'PSL root: liverpool.com.mx': registrable('liverpool.com.mx') === 'liverpool.com.mx',
    'deny: amazon marketplace': isDeniedDomain('https://amazon.com/dp/123') === true,
    'deny: eneba reseller': isDeniedDomain('eneba.com') === true,
    'deny: instagram social': isDeniedDomain('https://www.instagram.com/tesco') === true,
    'deny: gift-card infra portal (redeem.tillo.io)':
      isDeniedDomain('https://redeem.tillo.io/abc') === true,
    'deny: infra beats a supplier-anchored redeemUrl':
      scoreCandidate('https://wgiftcard.com/redeem', { name: 'Aerie', supplierAnchored: true })
        .confidence === 0,
    'allow: a real brand domain': isDeniedDomain('aerie.com') === false,
    'score: exact name → ≥0.9':
      scoreCandidate('tesco.co.uk', { name: 'Tesco', country: 'GB' }).confidence >= 0.9,
    'score: denied → 0': scoreCandidate('eneba.com', { name: 'Tesco' }).confidence === 0,
    'supplier-anchored: ae.com for Aerie → ≥0.9 (SLD ≠ name)':
      scoreCandidate('ae.com', { name: 'Aerie', supplierAnchored: true }).confidence >= 0.9,
    'supplier-anchored cannot override the deny-list':
      scoreCandidate('eneba.com', { name: 'X', supplierAnchored: true }).confidence === 0,
    'resolve: picks brand over reseller/noise': (() => {
      const r = resolveDomain({ name: 'Tesco', country: 'GB' }, [
        'eneba.com',
        'tesco.co.uk',
        'freefire.io',
      ]);
      return r.domain === 'tesco.co.uk' && r.autoAccept === true;
    })(),
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && argv[0] === '--resolve') {
  const [name, country, ...candidates] = argv.slice(1);
  console.log(JSON.stringify(resolveDomain({ name, country }, candidates), null, 2));
} else if (isMain) {
  console.log('usage: domain-tools.mjs --self-test | --resolve "<name>" <country> <candidate...>');
}
