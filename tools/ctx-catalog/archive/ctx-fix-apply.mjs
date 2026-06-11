#!/usr/bin/env node
/**
 * Apply the AI fix-planner output (/tmp/fix-result-*.json) from the semantic sweep:
 *  - unlink: remove the wrong discount(s); if it leaves 0 products, disable.
 *  - retag:  bulk-update the merchant's country.
 *  - rename: clean the merchant name (skip on collision).
 *  - keep:   no-op (verified false positive).
 *   node scripts/ctx-fix-apply.mjs [--apply]
 */
import { readFileSync, existsSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const BASE = 'https://spend.ctx.com';
const TOKEN = (process.env.CTX_TOKEN ?? readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const M = new Map(JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m]));
const names = new Set(
  [...M.values()].filter((m) => m.status === 'enabled').map((m) => m.name.toLowerCase()),
);
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
async function retag(id, country) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${BASE}/merchants`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify({ filter: { ids: id, perPage: '10' }, country }),
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

const fixes = [];
for (let i = 0; i < 7; i++) {
  const f = `/tmp/fix-result-${i}.json`;
  if (!existsSync(f)) continue;
  let d;
  try {
    d = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  for (const x of d.fixes || []) fixes.push(x);
}
const tally = { unlink: 0, disable: 0, retag: 0, rename: 0, keep: 0, skip: 0, fail: 0 };
for (const fx of fixes) {
  const m = M.get(fx.id);
  if (!m) {
    tally.skip++;
    continue;
  }
  if (fx.action === 'keep') {
    tally.keep++;
    continue;
  }
  if (fx.action === 'rename') {
    if (!fx.newName || names.has(fx.newName.toLowerCase())) {
      tally.skip++;
      continue;
    }
    if (APPLY) {
      const r = await put(m.id, { name: fx.newName });
      if (r === true) tally.rename++;
      else tally.fail++;
    } else tally.rename++;
    continue;
  }
  if (fx.action === 'retag') {
    if (!fx.newCountry || fx.newCountry === m.country) {
      tally.skip++;
      continue;
    }
    if (APPLY) {
      const r = await retag(m.id, fx.newCountry);
      if (r === true) tally.retag++;
      else tally.fail++;
    } else tally.retag++;
    continue;
  }
  if (fx.action === 'unlink') {
    const rm = (fx.removeDiscounts || []).map((r) => r.p + ':' + String(r.id));
    const kept = (m.discounts || [])
      .filter((d) => !rm.includes(d.provider + ':' + String(d.providerId)))
      .map((d) => ({ provider: d.provider, providerId: d.providerId }));
    if (kept.length === (m.discounts || []).length) {
      tally.skip++;
      continue;
    } // nothing matched
    if (kept.length > 0) {
      if (APPLY) {
        const r = await put(m.id, { discounts: kept });
        if (r === true) tally.unlink++;
        else tally.fail++;
      } else tally.unlink++;
    } else {
      if (APPLY) {
        const r = await put(m.id, {
          status: 'disabled',
          statusReason: 'other',
          statusNote: 'mis-mapped product removed (semantic sweep), no valid own product',
        });
        if (r === true) tally.disable++;
        else tally.fail++;
      } else tally.disable++;
    }
    continue;
  }
  tally.skip++;
}
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} (${fixes.length} fixes):`, JSON.stringify(tally));
