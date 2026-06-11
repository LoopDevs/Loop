#!/usr/bin/env node
/**
 * Canonicalise brand casing across country variants: "ADIDAS Czechia" / "Adidas
 * Greece" → "adidas …". Picks the majority casing per brand stem, but when the
 * majority is ALL-CAPS and longer than 4 chars (i.e. not a short acronym like
 * IKEA/ASOS) it prefers the most common non-all-caps form, so "DECATHLON" →
 * "Decathlon" while "IKEA" stays "IKEA". Codifies the human-review casing rule.
 *   node scripts/ctx-casing-normalize.mjs [--apply]
 */
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const BASE = 'https://spend.ctx.com';
const TOKEN = (process.env.CTX_TOKEN ?? readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);

const CTRY =
  /[\s-]+(France|Germany|Spain|Italy|Belgium|Netherlands|Ireland|Austria|Portugal|Finland|Greece|Canada|Switzerland|Sweden|Denmark|Norway|Poland|Czechia|Luxembourg|Mexico|Australia|India|Turkey|Croatia|Egypt|Qatar|Kuwait|Bahrain|Oman|Saudi Arabia|UAE|South Africa|New Zealand|US|UK|USA|GB|[A-Z]{2,3})$/;
const brandOf = (n) => n.replace(CTRY, '').trim();
const isAllCaps = (s) => s === s.toUpperCase() && /[A-Z]/.test(s);

// group by lowercased brand stem
const groups = new Map();
for (const m of M) {
  const bp = brandOf(m.name);
  if (bp.length < 2) continue;
  const k = bp.toLowerCase();
  const g = groups.get(k) || { cases: new Map(), members: [] };
  g.cases.set(bp, (g.cases.get(bp) || 0) + 1);
  g.members.push(m);
  groups.set(k, g);
}

function canonical(cases) {
  const sorted = [...cases.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0][0];
  if (isAllCaps(top) && top.replace(/[^A-Za-z]/g, '').length > 4) {
    const nonCaps = sorted.find(([c]) => !isAllCaps(c));
    if (nonCaps) return nonCaps[0];
  }
  return top;
}

const renames = [];
for (const [, g] of groups) {
  if (g.cases.size < 2) continue;
  // Skip variant/descriptor names ("Dots.eco - Restore Kelp Forests", "Deezer Duo
  // - 1 Month") — the casing rule is for brands, not their sentence descriptors.
  if ([...g.cases.keys()].some((c) => c.includes(' - '))) continue;
  const canon = canonical(g.cases);
  for (const m of g.members) {
    const bp = brandOf(m.name);
    if (bp === canon) continue;
    const newName = canon + m.name.slice(bp.length);
    if (newName !== m.name) renames.push({ id: m.id, old: m.name, new: newName });
  }
}
console.log(`Casing: ${renames.length} renames${APPLY ? '' : ' — DRY RUN'}`);
renames.slice(0, 30).forEach((r) => console.log(`  "${r.old}"  →  "${r.new}"`));
if (!APPLY) {
  console.log('\n(dry-run)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function put(id, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${BASE}/merchants/${id}`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify({ id, ...body }),
        signal: AbortSignal.timeout(40000),
      });
      if (r.ok) return true;
      if (r.status >= 500 || r.status === 429) {
        await sleep(1500 * (i + 1));
        continue;
      }
      return { err: r.status };
    } catch (e) {
      if (i === 3) return { err: String(e.message) };
      await sleep(1500);
    }
  }
}
let ok = 0,
  fail = 0;
const q = [...renames];
async function worker() {
  while (q.length) {
    const p = q.shift();
    const r = await put(p.id, { name: p.new });
    if (r === true) ok++;
    else fail++;
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`Applied — ${ok} renamed, ${fail} fail`);
