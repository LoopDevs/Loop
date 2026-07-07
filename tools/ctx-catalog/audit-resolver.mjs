#!/usr/bin/env node
/**
 * audit-resolver.mjs — run the domain resolver against the recovered merchant
 * data and report accuracy issues. Codifies the data-driven audit that found the
 * deny-list bugs (a supplier's own domain — amazon.com for Amazon — being
 * wrongly denied) so a future deny-list/scoring change can't silently re-break a
 * real merchant. Re-run after any change to domain-tools.
 *
 * Each merchant's `domain` in the manifest is treated as its OWN domain. If the
 * resolver DENIES it, that's a candidate false positive — UNLESS the domain is a
 * known redemption portal (cashstar / tillo / giftcards.ca …), where a deny is
 * correct (the portal isn't the brand's storefront; it should be re-resolved).
 *
 * API:  auditResolver(merchants) → { deniedBrand, deniedPortal, autoAccept, needsReview }
 * CLI:  node audit-resolver.mjs --self-test
 *       node audit-resolver.mjs --audit         # runs over data/ctx-media-final.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scoreCandidate } from './domain-tools.mjs';
import { dataPath } from './paths.mjs';

// Domains that are NEVER a brand's storefront — a deny here is correct, so these
// are reported separately (they need re-resolution, not a deny-list change).
const PORTAL =
  /(^|\.)(cashstar\.com|tillo\.io|wgiftcard\.com|blackhawk[a-z]*\.com)$|giftcards\.ca$/i;

export function auditResolver(merchants) {
  const deniedBrand = []; // a real merchant's own domain wrongly denied → review the deny-list
  const deniedPortal = []; // denied but it's a portal → correct; needs re-resolution
  let autoAccept = 0;
  let needsReview = 0;
  for (const m of merchants || []) {
    if (!m || !m.domain) continue;
    const s = scoreCandidate(m.domain, { name: m.name });
    const denied = s.confidence === 0 && (s.reasons || []).some((r) => r.startsWith('denied'));
    if (denied) {
      (PORTAL.test(m.domain) ? deniedPortal : deniedBrand).push({ name: m.name, domain: m.domain });
    } else if (s.confidence >= 0.8) {
      autoAccept++;
    } else {
      needsReview++;
    }
  }
  return { deniedBrand, deniedPortal, autoAccept, needsReview };
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const res = auditResolver([
    { name: 'Amazon US', domain: 'amazon.com' }, // marketplace-brand's OWN domain → NOT wrongly denied
    { name: 'Aerie', domain: 'ae.com' }, // fine
    { name: 'Golf Town', domain: 'golftown.cashstar.com' }, // portal → deniedPortal, not deniedBrand
    { name: 'Widget Co', domain: 'eneba.com' }, // a real brand named Widget whose own domain is a reseller SLD → flagged
  ]);
  const checks = {
    "marketplace-brand's own domain is NOT flagged as wrongly denied": !res.deniedBrand.some(
      (x) => x.name === 'Amazon US',
    ),
    'a portal domain is bucketed as deniedPortal (correct), not deniedBrand':
      res.deniedPortal.some((x) => x.name === 'Golf Town') &&
      !res.deniedBrand.some((x) => x.name === 'Golf Town'),
    'a non-portal denied brand domain IS flagged for review': res.deniedBrand.some(
      (x) => x.name === 'Widget Co',
    ),
    'a clean brand domain counts toward auto-accept': res.autoAccept >= 1,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain && process.argv.includes('--audit')) {
  const f = dataPath('ctx-media-final.json');
  if (!existsSync(f)) {
    console.error('no ctx-media-final.json in data/');
    process.exit(2);
  }
  const res = auditResolver(Object.values(JSON.parse(readFileSync(f, 'utf8'))));
  console.log(`auto-accept: ${res.autoAccept} | needs-review: ${res.needsReview}`);
  console.log(`\ndenied — PORTALS (correct, need re-resolution): ${res.deniedPortal.length}`);
  res.deniedPortal.forEach((x) => console.log(`  ${x.name} → ${x.domain}`));
  console.log(
    `\ndenied — BRAND domains (REVIEW: possible deny-list false positive): ${res.deniedBrand.length}`,
  );
  res.deniedBrand.forEach((x) => console.log(`  ⚠ ${x.name} → ${x.domain}`));
  process.exit(0);
} else if (isMain) {
  console.log('usage: audit-resolver.mjs --self-test | --audit');
}
