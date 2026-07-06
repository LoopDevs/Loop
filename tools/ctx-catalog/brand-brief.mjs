#!/usr/bin/env node
/**
 * brand-brief.mjs — supplier-evidence aggregator + brief builder (media v2 plan,
 * the supplier-ingestion tier). "Bring all the raw data in and see what we're
 * left with."
 *
 * A merchant can have records from MULTIPLE suppliers (Tillo, SVS, EzPin) plus
 * CTX, each with different, partial data. This unions whatever each supplier
 * gives — verbatim, with provenance, NO normalization on the way in — and mines
 * the free text (redemption instructions, T&Cs, descriptions) for the one signal
 * that most improves accuracy: the merchant's own URL. A URL the supplier itself
 * ships for this merchant is authoritative identity, so it anchors the domain
 * over any web-search guess — which is what fixes picking the wrong brand for a
 * shared name (Bolt the rideshare vs. bolt.com the checkout co.).
 *
 * Deterministic only. The SEMANTIC extraction (redeemableAt cross-brands,
 * inclusion-vs-exclusion, category inference) is the Claude structured pass on
 * top (next) — this layer produces the clean, high-trust INPUT for it.
 *
 * API:
 *   extractUrls(text)            → ['https://…', …] (deduped, trailing punct trimmed)
 *   aggregateSuppliers(bundle)   → { suppliers, websiteUrls, embeddedUrls, textBlob }
 *   buildBrief(merchant, bundle, searchCandidates?) → the brief (domain anchored to supplier URLs)
 *
 * CLI:
 *   node brand-brief.mjs --self-test
 */
import { fileURLToPath } from 'node:url';
import { scoreCandidate } from './domain-tools.mjs';

// http(s) URLs embedded in free text. Deliberately conservative — bare "ae.com"
// mentions are too noisy to trust from arbitrary prose; explicit website fields
// (below) carry those.
const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

export function extractUrls(text) {
  if (!text) return [];
  const found = String(text).match(URL_RE) || [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?)\]}>"']+$/, '')))];
}

/**
 * Union every supplier record in a bundle. `bundle` is `{ tillo:{…}, svs:{…},
 * ezpin:{…}, ctx:{…} }` of RAW records. Collects explicit website/URL fields +
 * every string value's embedded URLs, keeping which supplier each came from.
 */
export function aggregateSuppliers(bundle) {
  const suppliers = Object.keys(bundle || {}).filter((k) => bundle[k]);
  const websiteUrls = [];
  const embeddedUrls = [];
  const texts = [];
  const walk = (sup, val, key = '') => {
    if (val == null) return;
    if (typeof val === 'string') {
      texts.push(val);
      if (/^https?:\/\//i.test(val.trim()) && /url|website|site|link|redeem/i.test(key)) {
        websiteUrls.push({ url: val.trim(), supplier: sup, field: key });
      }
      for (const u of extractUrls(val)) embeddedUrls.push({ url: u, supplier: sup, field: key });
    } else if (Array.isArray(val)) {
      val.forEach((v) => walk(sup, v, key));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) walk(sup, v, k);
    }
  };
  for (const sup of suppliers) walk(sup, bundle[sup]);
  return { suppliers, websiteUrls, embeddedUrls, textBlob: texts.join('\n') };
}

/**
 * Build a brand brief: aggregate the raw supplier bundle + resolve the
 * authoritative domain, PREFERRING supplier-provided URLs (anchored) over
 * web-search candidates. Keeps the raw bundle verbatim for provenance +
 * downstream (LLM) extraction. `redeemableAt` is left null — the semantic pass
 * fills it.
 */
export function buildBrief(merchant, bundle = {}, searchCandidates = []) {
  const agg = aggregateSuppliers(bundle);
  const supplierUrls = [...new Set([...agg.websiteUrls, ...agg.embeddedUrls].map((x) => x.url))];
  const scored = [
    ...supplierUrls.map((u) =>
      scoreCandidate(u, {
        name: merchant.name,
        country: merchant.country,
        supplierAnchored: true,
      }),
    ),
    ...searchCandidates.map((c) =>
      scoreCandidate(c, { name: merchant.name, country: merchant.country }),
    ),
  ]
    // Drop confidence-0 candidates (denied resellers/marketplaces, unresolvable)
    // so a merchant whose only URL is a reseller resolves to NO domain (→ review)
    // rather than adopting the reseller as its identity.
    .filter((s) => s.domain && s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
  const best = scored[0] || { domain: null, confidence: 0, reasons: ['no-candidates'] };
  return {
    id: merchant.id,
    name: merchant.name,
    country: merchant.country,
    category: merchant.category,
    domain: best.domain,
    domainConfidence: best.confidence,
    domainReasons: best.reasons,
    domainAnchored: best.reasons?.includes('supplier-anchored') || false,
    suppliers: agg.suppliers,
    supplierUrlCount: supplierUrls.length,
    redeemableAt: null, // semantic Claude pass fills this
    raw: bundle, // verbatim, with provenance — never normalised away
  };
}

// ── CLI (only when run directly, never on import) ───────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  // A merchant with two suppliers whose data is complementary: Tillo carries a
  // website field; SVS buries the URL in the redemption text. Neither SLD
  // matches the name ("Aerie" → ae.com) — the wrong-brand trap the anchor fixes.
  const aerie = buildBrief(
    { id: 'm1', name: 'Aerie', country: 'US' },
    {
      tillo: { name: 'Aerie', websiteUrl: 'https://www.ae.com' },
      svs: { redemptionNote: 'Redeem online at https://www.ae.com/aerie or in any AE store.' },
    },
    ['aerie-fanpage.net'], // a weak web guess that must NOT win over the supplier URL
  );
  const agg = aggregateSuppliers({
    tillo: { terms: 'See https://brand.com/terms' },
    svs: { note: 'also https://brand.com/help' },
  });
  const reseller = buildBrief(
    { id: 'm2', name: 'SomeBrand', country: 'US' },
    { tillo: { redeemUrl: 'https://www.eneba.com/somebrand' } }, // reseller in a supplier field
  );

  const checks = {
    'extractUrls trims trailing punctuation':
      extractUrls('go to https://x.com/a).')[0] === 'https://x.com/a',
    'aggregates URLs across multiple suppliers': agg.embeddedUrls.length === 2,
    'supplier URL anchors the domain (ae.com for Aerie)': aerie.domain === 'ae.com',
    'anchored confidence is high despite SLD≠name':
      aerie.domainConfidence >= 0.9 && aerie.domainAnchored,
    'raw bundle kept verbatim with provenance':
      aerie.raw.tillo.websiteUrl === 'https://www.ae.com' && aerie.suppliers.length === 2,
    'deny-list beats a reseller URL even in a supplier field': reseller.domain !== 'eneba.com',
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '\nSELF-TEST PASS ✓' : '\nSELF-TEST FAIL ✗');
  process.exit(ok ? 0 : 1);
} else if (isMain) {
  console.log('usage: brand-brief.mjs --self-test');
}
