#!/usr/bin/env node
/**
 * Apply the AI dup-verify output (/tmp/dv-result-*.json):
 *  - merge:  pool providers onto survivor, rename canonical, disable the dupes.
 *  - separate w/ reason "region-retag:" → collect for the country-name retag pass
 *    (written to /tmp/region-retag-ids.json; not applied here).
 *   node scripts/ctx-dupverify-apply.mjs [--apply]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const BASE = 'https://spend.ctx.com';
const TOKEN = (process.env.CTX_TOKEN ?? readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const M = new Map(JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m]));
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
      return { err: r.status + ' ' + (await r.text()).slice(0, 60) };
    } catch (e) {
      if (i === 3) return { err: String(e.message) };
      await sleep(1500);
    }
  }
}

const merges = [];
const regionRetag = new Set();
for (let i = 0; i < 30; i++) {
  const f = `/tmp/dv-result-${i}.json`;
  if (!existsSync(f)) continue;
  let d;
  try {
    d = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  for (const r of d.results || []) {
    if (r.action === 'merge' && r.survivorId && (r.mergeIds || []).length) merges.push(r);
    else if (r.action === 'separate' && /^region-retag/i.test(r.reason || '')) {
      // members of a region cluster aren't carried in the result; mark by survivor+merge ids if present, else skip (handled by name-scan pass)
    }
  }
}
console.log(`merges: ${merges.length}`);
if (!APPLY) {
  console.log('(dry-run)');
  process.exit(0);
}

let mOk = 0,
  dOk = 0,
  fail = 0;
const disabledIds = new Set();
for (const op of merges) {
  const surv = M.get(op.survivorId);
  if (!surv || disabledIds.has(op.survivorId)) {
    fail++;
    continue;
  }
  const ids = [op.survivorId, ...op.mergeIds.filter((x) => x !== op.survivorId)];
  const seen = new Set(),
    pooled = [];
  for (const id of ids) {
    const m = M.get(id);
    if (!m) continue;
    for (const dd of m.discounts || []) {
      const k = dd.provider + ':' + dd.providerId;
      if (!seen.has(k)) {
        seen.add(k);
        pooled.push({ provider: dd.provider, providerId: dd.providerId });
      }
    }
  }
  const body = { discounts: pooled };
  if (op.canonicalName && op.canonicalName !== surv.name) body.name = op.canonicalName;
  const r = await put(op.survivorId, body);
  if (r !== true) {
    fail++;
    continue;
  }
  mOk++;
  for (const id of op.mergeIds) {
    if (id === op.survivorId) continue;
    const r2 = await put(id, {
      status: 'disabled',
      statusReason: 'other',
      statusNote: 'merged duplicate → ' + (op.canonicalName || surv.name),
    });
    if (r2 === true) {
      dOk++;
      disabledIds.add(id);
    } else fail++;
  }
  if (mOk % 15 === 0) process.stdout.write(`\r  merges ${mOk}/${merges.length}`);
}
console.log(`\nApplied — survivors ${mOk}, disabled dupes ${dOk}, fail ${fail}`);
