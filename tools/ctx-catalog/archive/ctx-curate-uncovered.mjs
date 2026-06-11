#!/usr/bin/env node
/**
 * Build the full new-merchant work-list for 100% supplier coverage (read-only).
 *
 * Goal: maximum coverage — every SVS / Tillo / EzPin brand becomes purchasable,
 * including regional variants (Amazon MX etc.). So we DON'T drop out-of-market
 * brands. Each unmapped brand is classified as:
 *   - create        no existing merchant → NEW merchant (then attach discount)
 *   - allocate-only  a merchant already exists → just attach the supplier discount
 *   - skip-test      obvious test/junk row
 *
 * Within `create` we tag (informational, not dropped): in-routed-market (ADR 034
 * US/GB/CA/EUR) vs other-market, and — for Tillo — whether the supplier already
 * ships a logo + cover + description (so we know the real media workload).
 *
 * Writes /tmp/curated-new-brands.json (the create list) +
 * /tmp/allocate-only-brands.json (existing-merchant, attach-discount list).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8'));
const ezpin = JSON.parse(readFileSync('/tmp/ezpin-discounts.json', 'utf8'));
const svsRaw = JSON.parse(readFileSync('/tmp/svs-products.json', 'utf8'));
const svs = Array.isArray(svsRaw) ? svsRaw : svsRaw.result || [];

const MARKET_COUNTRIES = new Set([
  'US',
  'GB',
  'CA',
  'FR',
  'DE',
  'IT',
  'ES',
  'NL',
  'IE',
  'BE',
  'AT',
  'FI',
  'PT',
  'GR',
  'LU',
  'SK',
  'SI',
  'LT',
  'LV',
  'EE',
  'CY',
  'MT',
  'HR',
]);
const MARKET_CCY = new Set(['USD', 'GBP', 'EUR', 'CAD']);
const EZ_MARKET_CCY = new Set(['Dollars($)', 'Euro(€)', 'Pounds(£)', 'Dollars(CAD$)']);

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
const slugify = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const isTest = (n) => /\btest\b/i.test(n || '') || /TestService/i.test(n || '');

const mapped = { svs: new Set(), tillo: new Set(), ezpin: new Set() };
const existNorm = new Set();
for (const m of merchants) {
  for (const d of m.discounts || []) mapped[d.provider]?.add(d.providerId);
  existNorm.add(norm(m.name));
}
// Exact-name existing-merchant check only — regional variants (Amazon MX vs
// Amazon) stay distinct, which is what "the more the better" wants.
const merchantExists = (name) => existNorm.has(norm(name));

const create = [];
const allocateOnly = [];
let skipTest = 0;

const route = (rec) => {
  if (merchantExists(rec.name)) allocateOnly.push(rec);
  else create.push(rec);
};

// ── Tillo ──
for (const b of tillo) {
  if (mapped.tillo.has(b.slug || slugify(b.name))) continue;
  if (isTest(b.name)) {
    skipTest++;
    continue;
  }
  const served = b.countries_served || [];
  route({
    name: b.name,
    supplier: 'tillo',
    slug: b.slug,
    currency: b.currency,
    countries: served,
    inMarket: MARKET_CCY.has(b.currency) && served.some((c) => MARKET_COUNTRIES.has(c)),
    logo: b.detail?.assets?.logo_url ?? null,
    cover: b.detail?.assets?.gift_card_url ?? null,
    hasDescription: !!(b.detail?.description && String(b.detail.description).trim()),
  });
}

// ── EzPin (group SKUs to a brand name) ──
const ez = {};
for (const p of ezpin) {
  if (isTest(p.name)) continue;
  const e = (ez[p.name] ??= {
    name: p.name,
    anyMapped: false,
    anyMarket: false,
    currencies: new Set(),
  });
  e.currencies.add(p.currency);
  if ((p.asg || 0) > 0 || mapped.ezpin.has(p.id)) e.anyMapped = true;
  if (EZ_MARKET_CCY.has(p.currency)) e.anyMarket = true;
}
for (const b of Object.values(ez)) {
  if (b.anyMapped) continue;
  route({
    name: b.name,
    supplier: 'ezpin',
    currencies: [...b.currencies],
    inMarket: b.anyMarket,
    logo: null,
    cover: null,
    hasDescription: false,
  });
}

// ── SVS ──
for (const p of svs) {
  if (mapped.svs.has(p.Id)) continue;
  if (isTest(p.Name)) continue;
  route({
    name: p.Name,
    supplier: 'svs',
    id: p.Id,
    currency: p.CurrencyCode,
    inMarket: MARKET_CCY.has(p.CurrencyCode),
    logo: p.Media?.LogoUrl ?? null,
    cover: null,
    hasDescription: !!(p.ShortDescription || p.LongDescription),
  });
}

create.sort((a, b) => a.name.localeCompare(b.name));
allocateOnly.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('/tmp/curated-new-brands.json', JSON.stringify(create, null, 2));
writeFileSync('/tmp/allocate-only-brands.json', JSON.stringify(allocateOnly, null, 2));

const bySupplier = (list, s) => list.filter((x) => x.supplier === s);
const inMkt = create.filter((c) => c.inMarket).length;
const tilloC = bySupplier(create, 'tillo');
const tilloMedia = tilloC.filter((c) => c.logo && c.cover).length;
const tilloDesc = tilloC.filter((c) => c.hasDescription).length;
const needMedia = create.filter((c) => !(c.logo && c.cover)).length;

console.log('MAX-COVERAGE WORK-LIST (read-only) ───────────────────');
console.log(`  CREATE new merchants: ${create.length}`);
console.log(
  `    • Tillo ${tilloC.length}  | EzPin ${bySupplier(create, 'ezpin').length}  | SVS ${bySupplier(create, 'svs').length}`,
);
console.log(
  `    • in routed market (US/GB/CA/EUR): ${inMkt}  | other markets: ${create.length - inMkt}`,
);
console.log(`  ALLOCATE-ONLY (merchant exists, attach discount): ${allocateOnly.length}`);
console.log(`  skipped test rows: ${skipTest}`);
console.log('');
console.log('  Media workload for the CREATE set:');
console.log(
  `    • Tillo ships logo+cover: ${tilloMedia}/${tilloC.length}, description: ${tilloDesc}/${tilloC.length}`,
);
console.log(`    • Need sourced media (no supplier asset): ${needMedia} (mostly EzPin)`);
console.log('');
console.log(
  '  CREATE sample:',
  create
    .slice(0, 24)
    .map((k) => k.name)
    .join(', '),
);
console.log('  wrote /tmp/curated-new-brands.json + /tmp/allocate-only-brands.json');
