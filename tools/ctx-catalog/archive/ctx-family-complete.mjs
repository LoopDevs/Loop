#!/usr/bin/env node
/**
 * Direct-card family completeness (overlap linking). For each DIRECT family card
 * (from the umbrella audit), link the card's supplier product onto EVERY brand it
 * covers — both existing merchants (re-enabling if disabled) and the audit's
 * "missing" brands (create + link). Only DIRECT cards (swap cards excluded), so a
 * customer always gets a directly-redeemable card; CTX picks the higher discount.
 *   node scripts/ctx-family-complete.mjs [--apply]
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
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const canon = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const CTRY =
  /\b(us|usa|u\.?s\.?a?|uk|gb|gbr|canada|can|ca|ireland|ire|ie|germany|ger|de|france|fra|fr|italy|italia|ita|it|spain|esp|es|netherlands|nld|nl|belgium|bel|be|austria|aut|at|finland|fin|fi|portugal|prt|pt|greece|grc|gr)\b/gi;
const mkey = (s) => canon(String(s || '').replace(CTRY, ' '));
const idx = new Map();
for (const m of M) {
  const k = mkey(m.name) + '|' + (m.country || '');
  if (!idx.has(k)) idx.set(k, m);
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
      return { err: r.status + ' ' + (await r.text()).slice(0, 70) };
    } catch (e) {
      if (i === 3) return { err: String(e.message) };
      await sleep(1500);
    }
  }
}
async function create(name, country) {
  const r = await fetch(`${BASE}/merchants`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name, country }),
    signal: AbortSignal.timeout(40000),
  });
  if (!r.ok) return { err: r.status + ' ' + (await r.text()).slice(0, 70) };
  return { id: (await r.json()).id };
}

// gather direct families (dedup by sku)
const fams = new Map();
for (let i = 0; i < 14; i++) {
  const f = `/tmp/umbrella-result-${i}.json`;
  if (!existsSync(f)) continue;
  let d;
  try {
    d = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  for (const u of d.umbrellas || []) {
    if (u.model !== 'direct' || !(u.missing || []).length || !u.sku) continue;
    const country = M.find((m) => m.id === u.merchantId)?.country || 'US';
    fams.set(u.sku, {
      sku: u.sku,
      country,
      missing: u.missing.map((x) => (typeof x === 'string' ? x : x.name || '')).filter(Boolean),
    });
  }
}
let linked = 0,
  reenabled = 0,
  created = 0,
  fail = 0;
const creates = [];
for (const fam of fams.values()) {
  const [prov, pid] = String(fam.sku).split(':');
  for (const brand of fam.missing) {
    const m = idx.get(mkey(brand) + '|' + fam.country);
    if (m) {
      const has = (m.discounts || []).some(
        (d) => d.provider === prov && String(d.providerId) === String(pid),
      );
      if (has && m.status === 'enabled') continue;
      const discounts = (m.discounts || []).map((d) => ({
        provider: d.provider,
        providerId: d.providerId,
      }));
      if (!has) discounts.push({ provider: prov, providerId: pid });
      const body = { discounts };
      if (m.status !== 'enabled') body.status = 'enabled';
      if (APPLY) {
        const r = await put(m.id, body);
        if (r === true) {
          linked++;
          if (m.status !== 'enabled') reenabled++;
        } else fail++;
      } else {
        linked++;
        if (m.status !== 'enabled') reenabled++;
      }
    } else {
      creates.push(`${brand} [${fam.country}] ← ${prov}`);
      if (APPLY && process.argv.includes('--with-creates')) {
        const c = await create(brand, fam.country);
        if (c.id) {
          const r = await put(c.id, { discounts: [{ provider: prov, providerId: pid }] });
          if (r === true) created++;
          else fail++;
        } else fail++;
      }
    }
  }
}
console.log(
  `${APPLY ? 'APPLIED' : 'DRY RUN'} — link/re-enable existing: ${linked} (of which re-enabled ${reenabled}), create+link: ${APPLY ? created : creates.length}, fail ${fail}`,
);
if (!APPLY) {
  console.log('CREATES:');
  creates.slice(0, 60).forEach((c) => console.log('  ' + c));
}
