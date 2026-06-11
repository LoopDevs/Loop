#!/usr/bin/env node
/**
 * Cross-provider coverage gap report (read-only). For each supplier
 * (SVS, Tillo, Ezpin), classifies every catalogue product as:
 *   - mapped:        a CTX merchant already references this provider product
 *   - missing-supply: NOT mapped, but a merchant with this brand name exists
 *                     → just add the discount to that merchant
 *   - uncovered:     NOT mapped, no matching merchant → candidate NEW merchant
 *
 * Goal: every provider product mapped to one of our merchants (max coverage).
 */
import { readFileSync } from 'node:fs';

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const svsRaw = JSON.parse(readFileSync('/tmp/svs-products.json', 'utf8'));
const svs = Array.isArray(svsRaw) ? svsRaw : svsRaw.result || [];
const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8'));
const ezpin = JSON.parse(readFileSync('/tmp/ezpin-discounts.json', 'utf8'));

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
const stripCountry = (n) => n.replace(/\s+(US|USA|UK|GB|Canada|CA|Europe|EU)$/i, '');

// Mapped provider-ids per provider, and merchant-name index.
const mapped = { svs: new Set(), tillo: new Set(), ezpin: new Set() };
const merchantByName = {};
for (const m of merchants) {
  for (const d of m.discounts || []) mapped[d.provider]?.add(d.providerId);
  merchantByName[norm(stripCountry(m.name))] ??= [];
  merchantByName[norm(stripCountry(m.name))].push(m);
}
const hasMerchant = (name) => merchantByName[norm(stripCountry(name))]?.length > 0;

function classify(label, items, idOf, nameOf, isMapped, keep = () => true) {
  let map = 0;
  const missing = [];
  const uncovered = [];
  for (const it of items) {
    if (!keep(it)) continue;
    if (isMapped(it)) {
      map++;
      continue;
    }
    (hasMerchant(nameOf(it)) ? missing : uncovered).push(nameOf(it));
  }
  const uniq = (a) => [...new Set(a)];
  console.log(`\n━━ ${label} ━━`);
  console.log(
    `  mapped: ${map} | missing-supply (merchant exists): ${uniq(missing).length} brands | uncovered (no merchant): ${uniq(uncovered).length} brands`,
  );
  return { missing: uniq(missing), uncovered: uniq(uncovered) };
}

// SVS — keyed by product Id
const svsR = classify(
  'SVS (123 products)',
  svs,
  (p) => p.Id,
  (p) => p.Name,
  (p) => mapped.svs.has(p.Id),
);

// Tillo — keyed by slug derived from name
const tilloR = classify(
  'TILLO (259 brands)',
  tillo,
  (b) => slugify(b.name),
  (b) => b.name,
  (b) => mapped.tillo.has(slugify(b.name)),
);

// Ezpin — group to brands; skip test rows + keep USD/GBP/CAD only
const realCcy = /USD|\$|GBP|£|CAD|Pound|Dollar/i;
const ezBrands = {};
for (const p of ezpin) {
  if (/\btest\b/i.test(p.name)) continue;
  if (!realCcy.test(p.currency || '')) continue;
  const b = stripCountry(p.name);
  (ezBrands[b] ??= { name: b, mapped: false }).mapped ||=
    (p.asg || 0) > 0 || mapped.ezpin.has(p.id);
}
const ezList = Object.values(ezBrands);
const ezR = classify(
  'EZPIN (USD/GBP/CAD brands, test excluded)',
  ezList,
  (b) => b.name,
  (b) => b.name,
  (b) => b.mapped,
);

console.log(
  '\n================ ACTIONABLE: missing-supply (merchant exists, just map it) ================',
);
console.log('SVS:', svsR.missing.join(', ') || '(none)');
console.log(
  '\nTILLO:',
  tilloR.missing.slice(0, 40).join(', '),
  tilloR.missing.length > 40 ? `…+${tilloR.missing.length - 40}` : '',
);
console.log(
  '\nEZPIN:',
  ezR.missing.slice(0, 40).join(', '),
  ezR.missing.length > 40 ? `…+${ezR.missing.length - 40}` : '',
);
console.log(
  '\n================ UNCOVERED brands (no merchant — new-merchant candidates) ================',
);
console.log('SVS:', svsR.uncovered.join(', ') || '(none)');
console.log(
  '\nTILLO uncovered:',
  tilloR.uncovered.length,
  '| EZPIN uncovered:',
  ezR.uncovered.length,
);
