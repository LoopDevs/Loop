#!/usr/bin/env node
/**
 * Cross-brand-family split. For each combined card, link the card's supplier
 * product onto EVERY constituent brand merchant that already exists (country-aware
 * match, re-enabling if disabled), then disable the genuine combined-name record
 * (not when it's itself a constituent). Genuinely-missing constituents are REPORTED,
 * never blind-created (avoids duplicating e.g. "Marshalls US").
 *   node scripts/ctx-combined-split-apply.mjs [--apply]
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
const plan = JSON.parse(readFileSync('/tmp/combined-split-plan.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const canon = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const CTRY =
  /\b(us|usa|u\.?s\.?a?|uk|gb|gbr|canada|can|ca|ireland|ire|ie|germany|deutschland|ger|de|france|fra|fr|italy|italia|ita|it|spain|esp|es|netherlands|nederland|nld|nl|belgium|belgique|bel|be|austria|aut|at|finland|fin|fi|portugal|prt|pt|greece|grc|gr)\b/gi;
const mkey = (s) => canon(String(s || '').replace(CTRY, ' '));
const idx = new Map();
for (const m of M) {
  const k = mkey(m.name) + '|' + (m.country || '');
  if (!idx.has(k)) idx.set(k, m);
}

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
      return { err: r.status + ' ' + (await r.text()).slice(0, 90) };
    } catch (e) {
      if (i === 4) return { err: String(e.message) };
      await sleep(1500 * (i + 1));
    }
  }
}

let linked = 0,
  enabled = 0,
  disabled = 0;
const missing = [];
for (const fam of plan.families || []) {
  const famM = M.find((m) => m.id === fam.merchantId);
  const country = famM?.country || 'US';
  const constKeys = fam.constituents.map(mkey);
  for (const brand of fam.constituents) {
    const m = idx.get(mkey(brand) + '|' + country);
    const fd = { provider: fam.supplier, providerId: String(fam.providerId) };
    if (!m) {
      missing.push(`${brand} [${country}] (for ${fam.name.slice(0, 30)})`);
      continue;
    }
    const has = (m.discounts || []).some(
      (d) => d.provider === fd.provider && String(d.providerId) === fd.providerId,
    );
    if (has && m.status === 'enabled') {
      console.log(`  ${brand} ← ${fam.supplier} (already)`);
      continue;
    }
    const discounts = (m.discounts || []).map((d) => ({
      provider: d.provider,
      providerId: d.providerId,
    }));
    if (!has) discounts.push(fd);
    const body = { discounts };
    if (m.status !== 'enabled') body.status = 'enabled';
    console.log(
      `  ${m.name} ← link ${fam.supplier}:${fam.providerId}${m.status !== 'enabled' ? ' +re-enable' : ''}`,
    );
    if (APPLY) {
      const r = await put(m.id, body);
      if (r === true) {
        linked++;
        if (m.status !== 'enabled') enabled++;
      } else console.log('     ✗ ' + r.err);
    }
  }
  const famMissing = fam.constituents.filter((b) => !idx.get(mkey(b) + '|' + country)).length;
  if (fam.merchantId && famM && !constKeys.includes(mkey(famM.name)) && famMissing === 0) {
    console.log(`  → disable combined-name "${famM.name}"`);
    if (APPLY) {
      const r = await put(fam.merchantId, {
        status: 'disabled',
        statusReason: 'other',
        statusNote: 'split into constituent brand merchants',
      });
      if (r === true) disabled++;
    }
  }
}
console.log(
  `\n${APPLY ? 'APPLIED' : 'DRY RUN'} — linked ${linked}, re-enabled ${enabled}, combined-disabled ${disabled}`,
);
console.log(`MISSING constituents (no merchant — review, NOT auto-created): ${missing.length}`);
missing.forEach((x) => console.log('   ' + x));
