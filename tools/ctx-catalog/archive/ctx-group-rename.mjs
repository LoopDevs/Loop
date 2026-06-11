#!/usr/bin/env node
/**
 * ADR 032 display-grouping via the "Brand - Variant" naming convention.
 *
 * The foreign onboarding created one merchant per tier×duration×region SKU
 * ("Tinder 1 Month Platinum ARE" ×761), and the web list groups on the FIRST
 * " - " in the name. These SKUs have no " - ", so they render as 761 tiles.
 * This inserts " - " after the brand so they collapse to one brand tile PER
 * COUNTRY (groupMerchants in @loop/shared) — no merge, no data loss, each SKU
 * stays individually orderable as a variant.
 *
 * Brand = longest common word-prefix within a (verified-domain, country)
 * cluster of >=2, trimmed of trailing number/variant tokens (Month/Gold/…).
 * Only renames where it adds grouping value; skips already-grouped names.
 *
 * Reads /tmp/ctx-fresh.json + /tmp/ctx-domains-verified.json
 *   node scripts/ctx-group-rename.mjs            # dry-run plan
 *   node scripts/ctx-group-rename.mjs --apply    # PUT renames (CTX_TOKEN)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const BASE = 'https://spend.ctx.com';
const TOKEN = (
  process.env.CTX_TOKEN ||
  (existsSync('/tmp/ctx-token.txt') ? readFileSync('/tmp/ctx-token.txt', 'utf8') : '')
).trim();
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const verified = JSON.parse(readFileSync('/tmp/ctx-domains-verified.json', 'utf8'));
const byId = new Map(merchants.map((m) => [m.id, m]));

const VARIANT_TOK =
  /^(\d+|months?|weeks?|years?|days?|gold|platinum|plus|premium|diamonds?|tokens?|points?|coins?|uc|nc|cp|vc|gems?|credits?|wallet|card|gift|egift|digital|subscription|membership)$/i;

// Build (domain|country) clusters from keyed merchants with a verified domain.
const clusters = new Map();
for (const [id, v] of Object.entries(verified)) {
  if (!v.domain) continue;
  const m = byId.get(id);
  if (!m) continue;
  const key = v.domain + '|' + (m.country || '');
  (clusters.get(key) || clusters.set(key, []).get(key)).push(m);
}

function commonBrand(names) {
  const wordlists = names.map((n) => n.split(/\s+/));
  let prefix = [];
  for (let i = 0; ; i++) {
    const w = wordlists[0][i];
    if (w === undefined || !wordlists.every((wl) => wl[i] === w)) break;
    prefix.push(w);
  }
  while (prefix.length > 1 && VARIANT_TOK.test(prefix[prefix.length - 1])) prefix.pop();
  return prefix.join(' ').trim();
}

// Multi-product / dedup-heavy brands are handled by the AI normalization pass,
// not this string-prefix grouper (distinct product lines + France/FR dupes).
const EXCLUDE_DOMAINS = new Set([
  'xbox.com',
  'playstation.com',
  'nintendo.com',
  'microsoft.com',
  'apple.com',
]);

const plan = [];
for (const [key, members] of clusters) {
  if (members.length < 2) continue;
  if (EXCLUDE_DOMAINS.has(key.split('|')[0])) continue;
  // already grouped if all names share a " - " brand prefix
  const ungrouped = members.filter((m) => m.name.indexOf(' - ') < 0);
  if (ungrouped.length < 2) continue;
  const brand = commonBrand(ungrouped.map((m) => m.name));
  if (!brand || brand.length < 2) continue;
  for (const m of ungrouped) {
    if (!m.name.toLowerCase().startsWith(brand.toLowerCase())) continue;
    const suffix = m.name.slice(brand.length).trim();
    if (!suffix) continue; // the bare-brand base listing — leave it
    // Only group TRUE tier/duration/denomination variants — a suffix with a number
    // or a variant word. A bare country code ("adidas AT") is a per-country merchant
    // (often a mis-tag), not a variant — leave it for the country-retag pass instead.
    const isVariant =
      /\d/.test(suffix) ||
      /\b(month|week|year|day|gold|platinum|plus|premium|diamonds?|tokens?|points?|coins?|gems?|credits?|uc|nc|membership|subscription|pass|wallet)\b/i.test(
        suffix,
      );
    if (!isVariant) continue;
    const newName = `${brand} - ${suffix}`;
    if (newName !== m.name)
      plan.push({ id: m.id, old: m.name, new: newName, brand, country: m.country });
  }
}

// summary
const byBrand = {};
for (const p of plan)
  byBrand[`${p.brand} [${p.country}]`] = (byBrand[`${p.brand} [${p.country}]`] || 0) + 1;
const topBrands = Object.entries(byBrand).sort((a, b) => b[1] - a[1]);
console.log(
  `Plan: ${plan.length} renames across ${topBrands.length} (brand,country) groups${APPLY ? '' : ' — DRY RUN'}`,
);
console.log('Top groups → become 1 tile each:');
for (const [b, n] of topBrands.slice(0, 18))
  console.log(`  ${b.padEnd(34).slice(0, 34)} ${n} SKUs → 1`);
console.log('Sample renames:');
for (const p of plan.slice(0, 10)) console.log(`  "${p.old}"  →  "${p.new}"`);

if (!APPLY) {
  writeFileSync('/tmp/ctx-group-rename-plan.json', JSON.stringify(plan));
  console.log(
    `\n(${plan.length} planned; wrote /tmp/ctx-group-rename-plan.json. Re-run with --apply to write.)`,
  );
  process.exit(0);
}

let ok = 0,
  fail = 0;
const queue = [...plan];
async function worker() {
  while (queue.length) {
    const p = queue.shift();
    try {
      const r = await fetch(`${BASE}/merchants/${p.id}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify({ id: p.id, name: p.new }),
        signal: AbortSignal.timeout(40000),
      });
      if (r.ok) ok++;
      else {
        fail++;
        if (fail <= 5) console.log(`  ✗ ${p.old} → ${r.status}`);
      }
    } catch (e) {
      fail++;
      queue.push(p); // retry on network error
      await sleep(1000);
    }
    if ((ok + fail) % 100 === 0)
      process.stdout.write(`\r  ${ok + fail}/${plan.length} (ok ${ok}, fail ${fail})`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`\nDone. renamed ok:${ok} fail:${fail}`);
