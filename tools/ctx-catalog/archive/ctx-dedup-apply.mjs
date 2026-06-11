#!/usr/bin/env node
/**
 * Apply the AI dedup plan (/tmp/ctx-dedup-plan.json):
 *  - MERGE: pool every provider discount from survivor + dupes onto the survivor,
 *           rename it canonically, then disable the duplicate records (reversible).
 *  - GROUP: rename "Brand X" → "Brand - X" so ADR-032 collapses the variants.
 *   node scripts/ctx-dedup-apply.mjs           # dry-run counts
 *   node scripts/ctx-dedup-apply.mjs --apply
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
const M = new Map(JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m]));
const plan = JSON.parse(readFileSync('/tmp/ctx-dedup-plan.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function put(id, body) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${BASE}/merchants/${id}`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify({ id, ...body }),
        signal: AbortSignal.timeout(40000),
      });
      if (r.ok) return true;
      if (r.status === 429 || r.status >= 500) {
        await sleep(1500 * (i + 1));
        continue;
      }
      return { err: r.status + ' ' + (await r.text()).slice(0, 110) };
    } catch (e) {
      if (i === 4) return { err: String(e.message) };
      await sleep(1500 * (i + 1));
    }
  }
}

// count writes
let renames = 0;
for (const g of plan.groups || [])
  for (const id of g.memberIds || []) {
    const m = M.get(id);
    if (
      m &&
      m.name.indexOf(' - ') < 0 &&
      g.brand &&
      m.name.toLowerCase().startsWith(g.brand.toLowerCase()) &&
      m.name
        .slice(g.brand.length)
        .replace(/^[\s\-:]+/, '')
        .trim()
    )
      renames++;
  }
const disables = plan.merges.reduce((s, m) => s + (m.mergeIds || []).length, 0);
console.log(
  `Plan: ${plan.merges.length} survivor merges, ${disables} disables, ${renames} group renames${APPLY ? '' : ' — DRY RUN'}`,
);
if (!APPLY) process.exit(0);

let mOk = 0,
  mFail = 0,
  dOk = 0,
  dFail = 0;
for (const op of plan.merges) {
  const surv = M.get(op.survivorId);
  if (!surv) {
    mFail++;
    continue;
  }
  const seen = new Set(),
    pooled = [];
  for (const id of [op.survivorId, ...op.mergeIds]) {
    const mer = M.get(id);
    if (!mer) continue;
    for (const d of mer.discounts || []) {
      const k = d.provider + ':' + d.providerId;
      if (!seen.has(k)) {
        seen.add(k);
        pooled.push({ provider: d.provider, providerId: d.providerId });
      }
    }
  }
  const body = { discounts: pooled };
  if (op.canonicalName && op.canonicalName !== surv.name) body.name = op.canonicalName;
  const r = await put(op.survivorId, body);
  if (r === true) mOk++;
  else {
    mFail++;
    if (mFail <= 8) console.log(`  ✗ survivor ${op.canonicalName} → ${r.err}`);
    continue;
  }
  for (const id of op.mergeIds) {
    const r2 = await put(id, {
      status: 'disabled',
      statusReason: 'other',
      statusNote: 'merged duplicate → ' + op.canonicalName,
    });
    if (r2 === true) dOk++;
    else {
      dFail++;
      if (dFail <= 8) console.log(`  ✗ disable ${M.get(id)?.name} → ${r2.err}`);
    }
  }
  if (mOk % 15 === 0)
    process.stdout.write(`\r  merges ${mOk}/${plan.merges.length}, disabled ${dOk}`);
}
console.log(`\nMerges: survivors ok ${mOk} fail ${mFail} | disabled ${dOk} fail ${dFail}`);

let gOk = 0,
  gFail = 0;
for (const g of plan.groups || []) {
  if (!g.brand) continue;
  for (const id of g.memberIds || []) {
    const m = M.get(id);
    if (!m || m.name.indexOf(' - ') >= 0) continue;
    if (!m.name.toLowerCase().startsWith(g.brand.toLowerCase())) continue;
    const suffix = m.name
      .slice(g.brand.length)
      .replace(/^[\s\-:]+/, '')
      .trim();
    if (!suffix) continue;
    const r = await put(id, { name: `${g.brand} - ${suffix}` });
    if (r === true) gOk++;
    else {
      gFail++;
      if (gFail <= 8) console.log(`  ✗ rename ${m.name} → ${r.err}`);
    }
    if ((gOk + gFail) % 30 === 0) process.stdout.write(`\r  renames ${gOk + gFail}/${renames}`);
  }
}
console.log(`\nGroup renames: ok ${gOk} fail ${gFail}`);
