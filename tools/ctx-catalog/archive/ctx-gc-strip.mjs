#!/usr/bin/env node
/**
 * QC rule: strip generic "Gift Card(s)" / "e-Gift Card" from merchant names
 * ("Apple Gift Card Austria" → "Apple Austria"), EXCEPT where it's intrinsic to
 * the brand ("Town & City Gift Cards", "Gift Card Market …"). If the stripped name
 * collides with an existing same-country merchant, that's a duplicate → MERGE
 * (pool providers onto the survivor, disable the "Gift Card"-named one) rather than
 * a blind rename. Codifies the human-review finding so re-running catches the class.
 *   node scripts/ctx-gc-strip.mjs [--apply]
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
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const en = M.filter((m) => m.status === 'enabled');
const canon = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTRINSIC =
  /town & city|one4all|airlinegift|love2shop|gift card market|the gift card|gift card shop|^gift ?cards?\b/i;
const strip = (n) =>
  n
    .replace(/\s*\b(e-?)?gift\s?cards?\b\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const byKeyCountry = new Map();
for (const m of en) byKeyCountry.set(canon(m.name) + '|' + m.country, m);

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
      return { err: r.status + ' ' + (await r.text()).slice(0, 60) };
    } catch (e) {
      if (i === 3) return { err: String(e.message) };
      await sleep(1500);
    }
  }
}

const renames = [],
  merges = [],
  skip = [];
for (const m of en) {
  if (!/gift ?cards?/i.test(m.name) || INTRINSIC.test(m.name)) continue;
  const nn = strip(m.name);
  if (!nn || nn.length < 2 || canon(nn) === canon(m.name)) {
    skip.push(m.name);
    continue;
  }
  const collide = byKeyCountry.get(canon(nn) + '|' + m.country);
  if (collide && collide.id !== m.id) merges.push({ from: m, into: collide, nn });
  else renames.push({ m, nn });
}
console.log(
  `Gift-Card rule: ${renames.length} renames, ${merges.length} merges (collision→dup), ${skip.length} skipped`,
);
renames.slice(0, 8).forEach((r) => console.log(`  rename: "${r.m.name}" → "${r.nn}"`));
merges
  .slice(0, 8)
  .forEach((x) => console.log(`  MERGE: "${x.from.name}" → into existing "${x.into.name}"`));
if (!APPLY) {
  console.log('\n(dry-run)');
  process.exit(0);
}

let rOk = 0,
  mOk = 0,
  fail = 0;
for (const { m, nn } of renames) {
  const r = await put(m.id, { name: nn });
  if (r === true) rOk++;
  else {
    fail++;
    if (fail <= 5) console.log('  ✗ ' + m.name + ' ' + r.err);
  }
}
for (const { from, into } of merges) {
  const seen = new Set(),
    pooled = [];
  for (const mm of [into, from])
    for (const d of mm.discounts || []) {
      const k = d.provider + ':' + d.providerId;
      if (!seen.has(k)) {
        seen.add(k);
        pooled.push({ provider: d.provider, providerId: d.providerId });
      }
    }
  const r = await put(into.id, { discounts: pooled });
  if (r !== true) {
    fail++;
    continue;
  }
  const r2 = await put(from.id, {
    status: 'disabled',
    statusReason: 'other',
    statusNote: 'merged dup (Gift Card name) → ' + into.name,
  });
  if (r2 === true) mOk++;
  else fail++;
}
console.log(`Applied — renames ${rOk}, merges ${mOk}, fail ${fail}`);
