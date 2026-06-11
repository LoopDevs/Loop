#!/usr/bin/env node
/**
 * SVS allocation — de-duplicated, group-based (goal: sync Tillo/SVS/EzPin, deduped).
 * Source: /tmp/svs-products.json (full /system/svs/products, 123).
 * SVS product: { Id, Name, CurrencyCode, DenominationType(Variable|Fixed),
 *   Denominations[], Cost.DiscountPercentage, CultureCodes[] }.
 * Discount: {provider:svs, providerId:Id, denoms, bps=round(DiscountPercentage*100)}.
 * Dedup: skip Ids already linked; canon|country match ENABLED merchant → link else create.
 * Env CTX_TOKEN. Flags: --dry-run --limit N --only <key> --action create|link
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://spend.ctx.com';
const TOKEN = process.env.CTX_TOKEN || readFileSync('/tmp/ctx-token.txt', 'utf8').trim();
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const DRY = has('--dry-run');
const ACTION = val('--action');
const ONLY = val('--only');
const LIMIT = val('--limit') ? Number(val('--limit')) : Infinity;
const DONE_FILE = '/tmp/svs-allocate-done.json';
const SUPPORTED = new Set(['USD', 'GBP', 'CAD', 'EUR']);
const SUPPORTED_CTRY = new Set([
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const canon = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\.(com|co\.uk|co|net|org|de|fr|it|es|ie|nl|be|at|fi|pt|eu|gr)\b/g, ' ')
    .replace(
      /\b(usa|u\.?s\.?a?|uk|gb|gbr|canada|can|eu|europe|ireland|ire|germany|ger|france|fra|italy|ita|italia|spain|esp|espana|netherlands|nederland|belgium|belgie|bel|austria|osterreich|finland|suomi|fin|portugal|prt|greece|hellas|luxembourg|deutschland)\b/g,
      ' ',
    )
    .replace(
      /\b(gift ?cards?|e-?gift|egift|digital|voucher|e-?code|top-?up|prepaid|url|e-?mail|email|physical)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9]+/g, '')
    .trim();

function svsDiscount(p) {
  const bps = Math.round(Number(p.Cost?.DiscountPercentage) * 100);
  if (!Number.isFinite(bps) || bps <= 0) return null;
  const cur = p.CurrencyCode;
  const country = (p.CultureCodes || [])[0]?.split('-')[1];
  if (!cur || !SUPPORTED.has(cur) || !country || !SUPPORTED_CTRY.has(country)) return null;
  const vals = (p.Denominations || [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!vals.length) return null;
  const variable = String(p.DenominationType).toLowerCase().startsWith('var');
  const denominationType = variable ? 'min-max' : 'fixed';
  const denominationValues = (variable ? [Math.min(...vals), Math.max(...vals)] : vals).map((n) =>
    n.toFixed(2),
  );
  return {
    provider: 'svs',
    providerId: String(p.Id),
    countries: [country],
    currencies: [cur],
    denominationType,
    denominationValues,
    amountBasisPoints: bps,
    redeemLocations: ['online'],
    redeemTypes: ['url'],
  };
}

async function ctxFetch(url, opts, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(40000) });
      if (r.status === 429 || r.status >= 500) {
        await sleep(2000 * (i + 1));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr || new Error('failed');
}

function buildPlan() {
  const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
  const svs = JSON.parse(readFileSync('/tmp/svs-products.json', 'utf8'));
  const idsInUse = new Set();
  for (const m of merchants) {
    if (m.status && m.status !== 'enabled') continue;
    for (const d of m.discounts || [])
      if (String(d.provider).toLowerCase() === 'svs' && d.providerId)
        idsInUse.add(String(d.providerId));
  }
  const idx = new Map();
  for (const m of merchants) {
    if (m.status && m.status !== 'enabled') continue;
    idx.set(`${canon(m.name)}|${m.country}`, m);
  }
  const groups = new Map();
  for (const p of svs) {
    const name = String(p.Name || '').trim();
    if (!name || /test/i.test(name)) continue;
    const disc = svsDiscount(p);
    if (!disc) continue;
    if (idsInUse.has(String(p.Id))) continue;
    const key = `${canon(name)}|${disc.countries[0]}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, name, country: disc.countries[0], currency: disc.currencies[0], discs: [] };
      groups.set(key, g);
    }
    if (!g.discs.some((d) => d.providerId === disc.providerId)) g.discs.push(disc);
  }
  const plan = [];
  for (const g of groups.values()) {
    if (!g.discs.length) continue;
    const m = idx.get(g.key);
    if (!m) plan.push({ action: 'create', ...g });
    else {
      const newDiscs = g.discs.filter(
        (d) =>
          !(m.discounts || []).some(
            (e) =>
              String(e.provider).toLowerCase() === 'svs' &&
              String(e.providerId) === String(d.providerId),
          ),
      );
      if (newDiscs.length)
        plan.push({
          action: 'link',
          key: g.key,
          name: m.name,
          id: m.id,
          existing: m.discounts || [],
          discs: newDiscs,
        });
    }
  }
  return plan;
}

async function main() {
  const done = new Set(existsSync(DONE_FILE) ? JSON.parse(readFileSync(DONE_FILE, 'utf8')) : []);
  let plan = buildPlan().filter((p) => !done.has(p.key));
  if (ACTION) plan = plan.filter((p) => p.action === ACTION);
  if (ONLY) plan = plan.filter((p) => p.key === ONLY);
  plan = plan.slice(0, LIMIT === Infinity ? plan.length : LIMIT);
  const counts = plan.reduce((a, p) => ((a[p.action] = (a[p.action] || 0) + 1), a), {});
  console.log(`SVS plan: ${plan.length} (${JSON.stringify(counts)})${DRY ? ' — DRY' : ''}\n`);

  let ok = 0,
    fail = 0;
  for (const p of plan) {
    try {
      const rep = p.discs[0];
      if (DRY) {
        console.log(
          `  [${p.action}] ${p.name} [${p.country} ${p.currency}] svs:${rep.providerId} ${rep.denominationType} ${JSON.stringify(rep.denominationValues)} ${rep.amountBasisPoints}bps`,
        );
        continue;
      }
      if (p.action === 'create') {
        const cr = await ctxFetch(`${BASE}/merchants`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ name: p.name, country: p.country }),
        });
        const cj = await cr.json().catch(() => ({}));
        if (!cr.ok) {
          console.log(`  ✗ create ${p.name} → ${cr.status} ${JSON.stringify(cj).slice(0, 80)}`);
          fail++;
          continue;
        }
        const id = cj.id || cj.Id;
        await sleep(700);
        const put = {
          id,
          discounts: p.discs,
          denominationType: rep.denominationType,
          denominationValues: rep.denominationValues.join(','),
          userDiscount: String(rep.amountBasisPoints),
          status: 'enabled',
        };
        const pr = await ctxFetch(`${BASE}/merchants/${id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(put),
        });
        if (!pr.ok) {
          console.log(
            `  ⚠ ${p.name} created ${id} cfg → ${pr.status} ${(await pr.text().catch(() => '')).slice(0, 80)}`,
          );
          fail++;
          continue;
        }
        console.log(`  ✓ create ${p.name.slice(0, 28).padEnd(28)} ${id} ${p.currency}`);
        ok++;
      } else {
        const pr = await ctxFetch(`${BASE}/merchants/${p.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify({ id: p.id, discounts: [...p.existing, ...p.discs] }),
        });
        if (!pr.ok) {
          console.log(`  ✗ link ${p.name} → ${pr.status}`);
          fail++;
          continue;
        }
        console.log(`  ✓ link   ${p.name.slice(0, 28).padEnd(28)} +svs`);
        ok++;
      }
      done.add(p.key);
      if ((ok + fail) % 25 === 0) writeFileSync(DONE_FILE, JSON.stringify([...done]));
      await sleep(700);
    } catch (e) {
      console.log(`  ✗ ${p.name} ${e.message}`);
      fail++;
    }
  }
  writeFileSync(DONE_FILE, JSON.stringify([...done]));
  console.log(`\nDone. ok:${ok} fail:${fail}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
