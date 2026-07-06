#!/usr/bin/env node
/**
 * brand-family.mjs — brand-family fan-out (media v2 plan S5): resolve/QC a brand
 * ONCE, then share its region-agnostic assets across every regional variant.
 *
 * The catalog has regional variants of the same brand (Amazon US / Amazon UK /
 * Amazon CA / Amazon MX; adidas-ca / adidas-us; …). Today each variant is
 * sourced + QC'd independently — N× the work + N chances to pick a wrong or
 * inconsistent logo. But a brand's LOGO is the same in every market, so:
 *
 *   - group variants by a country-stripped family key,
 *   - within a family, propagate the best-resolved LOGO to the members that
 *     lack one — sourcing + vision-QC happen once per family, not per variant.
 *
 * NOTE: this shares the LOGO (region-agnostic) and the family identity — NOT the
 * exact domain, which is regional (amazon.com vs amazon.co.uk). Domain
 * resolution stays per-variant (brand-brief + the ccTLD bonus in domain-tools).
 *
 * API:
 *   familyKey(name)          → country-stripped, normalised family key ('amazon')
 *   groupByFamily(merchants) → Map<familyKey, merchant[]>
 *   shareLogo(merchants)     → { merchantId: { logoUrl, sharedFrom, familyKey } }
 *
 * CLI: node brand-family.mjs --self-test
 */
import { fileURLToPath } from 'node:url';

const STRIP =
  /\s+(us|usa|uk|gb|canada|ca|europe|eu|au|australia|mx|mexico|in|india|ae|uae|sa|ie|nz|de|fr|es|it|nl)$/i;

export function familyKey(name) {
  return (name || '')
    .toLowerCase()
    .replace(STRIP, '')
    .replace(/[^a-z0-9]/g, '');
}

export function groupByFamily(merchants) {
  const fam = new Map();
  for (const m of merchants || []) {
    const k = familyKey(m.name);
    if (!k) continue;
    if (!fam.has(k)) fam.set(k, []);
    fam.get(k).push(m);
  }
  return fam;
}

/**
 * Within each multi-member family, propagate the best-resolved logo to members
 * that lack one. "Best" = has a logoUrl, highest logoConfidence (ties → the one
 * a human/vision approved, i.e. logoReviewed === 'yes'). Only families with ≥2
 * members and at least one resolved logo produce shares.
 */
export function shareLogo(merchants) {
  const out = {};
  for (const [k, members] of groupByFamily(merchants)) {
    if (members.length < 2) continue;
    const src = members
      .filter((m) => m.logoUrl)
      .sort(
        (a, b) =>
          (b.logoReviewed === 'yes' ? 1 : 0) - (a.logoReviewed === 'yes' ? 1 : 0) ||
          (b.logoConfidence || 0) - (a.logoConfidence || 0),
      )[0];
    if (!src) continue;
    for (const m of members) {
      if (!m.logoUrl && m.id !== src.id)
        out[m.id] = { logoUrl: src.logoUrl, sharedFrom: src.id, familyKey: k };
    }
  }
  return out;
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const merchants = [
    { id: 'a-us', name: 'Amazon US', logoUrl: 'https://logo/amazon.png', logoConfidence: 0.9 },
    { id: 'a-uk', name: 'Amazon UK' }, // no logo → should inherit
    { id: 'a-ca', name: 'Amazon CA' }, // no logo → should inherit
    { id: 'solo', name: 'Wickes' }, // only member, no logo → no share
    { id: 'z-us', name: 'Zed US' }, // family with no logo anywhere → no share
    { id: 'z-uk', name: 'Zed UK' },
  ];
  const shares = shareLogo(merchants);
  const groups = groupByFamily(merchants);
  const checks = {
    'familyKey strips the country suffix':
      familyKey('Amazon US') === 'amazon' && familyKey('Amazon UK') === 'amazon',
    'groups regional variants together': groups.get('amazon').length === 3,
    'propagates the logo to variants that lack one':
      shares['a-uk']?.logoUrl === 'https://logo/amazon.png' &&
      shares['a-ca']?.logoUrl === 'https://logo/amazon.png',
    'records provenance (sharedFrom + family)':
      shares['a-uk']?.sharedFrom === 'a-us' && shares['a-uk']?.familyKey === 'amazon',
    'does not overwrite the source': shares['a-us'] === undefined,
    'no share for a solo merchant': shares['solo'] === undefined,
    'no share when no family member has a logo':
      shares['z-us'] === undefined && shares['z-uk'] === undefined,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain) {
  console.log('usage: brand-family.mjs --self-test');
}
