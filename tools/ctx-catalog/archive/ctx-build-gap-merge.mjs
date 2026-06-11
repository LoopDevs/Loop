#!/usr/bin/env node
/**
 * Builds a country-precise merge plan for the "missing-supply" gaps:
 * provider products whose brand+country matches an existing merchant
 * that lacks that provider. Output: /tmp/ctx-gap-merge.json
 *   { merchantId: { name, discounts: [<full union incl. new provider>] } }
 * Plus a report of confident matches vs skipped/ambiguous.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const svs = JSON.parse(readFileSync('/tmp/svs-products.json', 'utf8')).result || [];
const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8'));
const ezpin = JSON.parse(readFileSync('/tmp/ezpin-discounts.json', 'utf8'));

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/®|™|©/g, '')
    .replace(/[^a-z0-9]/g, '');
const stripCountry = (n) => n.replace(/\s+(US|USA|UK|GB|Canada|CA|Europe|EU)$/i, '').trim();
const ccyCountry = (s = '') =>
  /USD|\bUS\b|\$(?!.*£)|Dollar/i.test(s) && !/CAD/i.test(s)
    ? 'US'
    : /GBP|£|Pound|\bUK\b/i.test(s)
      ? 'GB'
      : /CAD|Canad/i.test(s)
        ? 'CA'
        : null;
const nameCountry = (n = '') =>
  /\bUSA\b|\bUS\b/i.test(n)
    ? 'US'
    : /\bUK\b/i.test(n)
      ? 'GB'
      : /\bCanada\b|\bCA\b/i.test(n)
        ? 'CA'
        : null;

// merchant lookup by (normBaseName, country)
const mByKey = {};
const mapped = { svs: new Set(), tillo: new Set(), ezpin: new Set() };
for (const m of merchants) {
  mByKey[`${norm(stripCountry(m.name))}|${m.country}`] = m;
  for (const d of m.discounts || []) mapped[d.provider]?.add(d.providerId);
}

const plan = {}; // merchantId -> {name, providers:Set of "prov:id"}
const matches = [];
const skipped = [];

function tryMatch(provider, productId, productName, country, label) {
  if (!country) {
    skipped.push(`${label}: ${productName} — no country`);
    return;
  }
  const m = mByKey[`${norm(stripCountry(productName))}|${country}`];
  if (!m) {
    skipped.push(`${label}: ${productName} [${country}] — no merchant`);
    return;
  }
  // True missing-supply only: the merchant must lack this provider entirely.
  // (Adding a 2nd id from a provider the merchant already has = redundant.)
  if ((m.discounts || []).some((d) => d.provider === provider)) return;
  const e = (plan[m.id] ??= {
    name: m.name,
    providers: new Set((m.discounts || []).map((d) => `${d.provider}:${d.providerId}`)),
  });
  e.providers.add(`${provider}:${productId}`);
  matches.push(`${label}: "${productName}" → "${m.name}" [${m.country}] +${provider}:${productId}`);
}

// SVS
for (const p of svs) {
  if (mapped.svs.has(p.Id)) continue;
  tryMatch('svs', p.Id, p.Name, ccyCountry(p.CurrencyCode) || nameCountry(p.Name) || 'US', 'SVS');
}
// Tillo
for (const b of tillo) {
  const slug = (b.name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (mapped.tillo.has(slug)) continue;
  const ctry =
    nameCountry(b.name) || ccyCountry(b.currency) || (Array.isArray(b.countries) && b.countries[0]);
  tryMatch('tillo', slug, b.name, ctry, 'TILLO');
}
// Ezpin — group brands, take a representative unmapped id per (brand,country)
const ezSeen = new Set();
for (const p of ezpin) {
  if (/\btest\b/i.test(p.name) || (p.asg || 0) > 0 || mapped.ezpin.has(p.id)) continue;
  const ctry = ccyCountry(p.currency);
  const key = `${norm(stripCountry(p.name))}|${ctry}`;
  if (ezSeen.has(key)) continue;
  ezSeen.add(key);
  tryMatch('ezpin', p.id, p.name, ctry, 'EZPIN');
}

// finalise
const out = {};
for (const [id, e] of Object.entries(plan))
  out[id] = {
    name: e.name,
    discounts: [...e.providers].map((s) => ({
      provider: s.split(':')[0],
      providerId: s.split(':').slice(1).join(':'),
    })),
  };
writeFileSync('/tmp/ctx-gap-merge.json', JSON.stringify(out, null, 2));

console.log(
  `Confident country-precise matches: ${matches.length} (across ${Object.keys(out).length} merchants)`,
);
matches.forEach((m) => console.log('  ' + m));
console.log(`\nSkipped/ambiguous: ${skipped.length}`);
skipped.slice(0, 25).forEach((s) => console.log('  ' + s));
if (skipped.length > 25) console.log(`  …+${skipped.length - 25}`);
