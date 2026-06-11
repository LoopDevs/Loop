#!/usr/bin/env node
/**
 * De-duplicated supplier sync — ANALYSIS pass (no writes).
 * Unifies Tillo + EzPin + SVS catalogues + existing Loop merchants into
 * (canonicalBrand, country) groups, so each brand+geography maps to ONE merchant
 * with all available suppliers linked. Reports create/link/overlap + samples to
 * sanity-check the matcher before applying. Goal: sync all 3 suppliers, deduped.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8'));
const ezpin = JSON.parse(readFileSync('/tmp/ezpin-products.json', 'utf8'));
const svs = JSON.parse(readFileSync('/tmp/svs-products.json', 'utf8'));
const loop = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));

// Country-name / culture-code → ISO. EzPin gives region names; SVS gives culture codes.
const REGION = {
  'united states': 'US',
  usa: 'US',
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  canada: 'CA',
  ireland: 'IE',
  france: 'FR',
  germany: 'DE',
  italy: 'IT',
  spain: 'ES',
  netherlands: 'NL',
  belgium: 'BE',
  austria: 'AT',
  finland: 'FI',
  portugal: 'PT',
  greece: 'GR',
  luxembourg: 'LU',
  slovakia: 'SK',
  slovenia: 'SI',
  lithuania: 'LT',
  latvia: 'LV',
  estonia: 'EE',
  cyprus: 'CY',
  malta: 'MT',
  croatia: 'HR',
};
const curToCountry = { USD: 'US', GBP: 'GB', CAD: 'CA' }; // EUR is ambiguous → need region

// Canonical brand key: drop TLDs, country words, gift-card words, punctuation.
function canon(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.(com|co\.uk|co|net|org|de|fr|it|es|ie|nl|be|at|fi|pt|eu|gr)\b/g, ' ')
    .replace(
      /\b(usa|u\.?s\.?a?|uk|gb|gbr|canada|can|eu|europe|ireland|ire|germany|ger|france|fra|italy|ita|italia|spain|esp|espana|netherlands|nederland|belgium|belgie|bel|austria|osterreich|finland|suomi|fin|portugal|prt|greece|hellas|luxembourg|deutschland)\b/g,
      ' ',
    )
    .replace(/\b(gift ?cards?|e-?gift|egift|digital|voucher|e-?code|top-?up|prepaid)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

const records = []; // {canon, country, currency, source, name}
// Tillo
for (const b of tillo) {
  const country = (b.countries_served || [])[0] || curToCountry[b.currency] || '?';
  records.push({
    canon: canon(b.name),
    country,
    currency: b.currency,
    source: 'tillo',
    name: b.name,
  });
}
// EzPin (collapse the per-denomination rows to per-product via sku)
const ezSeen = new Set();
for (const p of ezpin) {
  const d = p.product || {};
  if (ezSeen.has(d.sku)) continue;
  ezSeen.add(d.sku);
  const cur = d.currency?.code || '?';
  const regName = (d.regions || [])[0]?.name?.toLowerCase();
  const country = REGION[regName] || curToCountry[cur] || '?';
  records.push({ canon: canon(d.title), country, currency: cur, source: 'ezpin', name: d.title });
}
// SVS
for (const p of svs) {
  const cur = p.CurrencyCode || '?';
  const culture = (p.CultureCodes || [])[0] || '';
  const country = culture.split('-')[1] || curToCountry[cur] || '?';
  records.push({
    canon: canon(p.Name || p.ProductName || p.Title),
    country,
    currency: cur,
    source: 'svs',
    name: p.Name || p.ProductName || p.Title,
  });
}
// Loop (existing)
for (const m of loop) {
  records.push({
    canon: canon(m.name),
    country: m.country,
    currency: m.currency,
    source: 'loop',
    name: m.name,
    status: m.status,
  });
}

// Group by canon|country
const groups = new Map();
for (const r of records) {
  if (!r.canon) continue;
  const k = `${r.canon}|${r.country}`;
  if (!groups.has(k)) groups.set(k, { sources: new Set(), recs: [] });
  const g = groups.get(k);
  g.sources.add(r.source);
  g.recs.push(r);
}

let withLoop = 0,
  newGroups = 0,
  multiSupplier = 0;
const createSamples = [],
  linkSamples = [];
for (const [k, g] of groups) {
  const hasLoop = g.sources.has('loop');
  const supCount = [...g.sources].filter((s) => s !== 'loop').length;
  if (supCount >= 2) multiSupplier++;
  if (hasLoop) {
    withLoop++;
    if (supCount >= 1 && linkSamples.length < 8)
      linkSamples.push([k, [...g.sources].join('+'), g.recs.map((r) => r.name).slice(0, 4)]);
  } else if (supCount >= 1) {
    newGroups++;
    if (createSamples.length < 8)
      createSamples.push([k, [...g.sources].join('+'), g.recs.map((r) => r.name).slice(0, 3)]);
  }
}

console.log('Records:', records.length, '| unique (brand,country) groups:', groups.size);
console.log('Groups WITH an existing Loop merchant (→ link suppliers):', withLoop);
console.log('Groups with NO Loop merchant (→ create + link):', newGroups);
console.log('Groups offered by 2+ suppliers (cross-supplier dedup):', multiSupplier);
console.log('\n--- sample CREATE groups (no existing merchant) ---');
for (const [k, s, names] of createSamples) console.log(`  [${s}] ${k}  ⇐ ${names.join(' | ')}`);
console.log(
  '\n--- sample LINK groups (existing merchant + supplier) — verify these are TRUE matches ---',
);
for (const [k, s, names] of linkSamples) console.log(`  [${s}] ${k}  ⇐ ${names.join(' | ')}`);

// spot-check the format-mismatch cases the user caught
console.log('\n--- spot-check baskets / apple unification ---');
for (const probe of ['1800baskets', '1800petsupplies', 'apple']) {
  for (const [k, g] of groups)
    if (k.startsWith(probe + '|'))
      console.log(
        `  ${k}: ${[...g.sources].join('+')} ⇐ ${g.recs
          .map((r) => r.source + ':' + r.name)
          .slice(0, 5)
          .join(' | ')}`,
      );
}
