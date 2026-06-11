#!/usr/bin/env node
/**
 * EzPin allocation — de-duplicated, GROUP-based (goal: sync Tillo/SVS/EzPin, deduped).
 * Source: /tmp/ezpin-catalogs.json (full /system/ezpin/catalogs).
 *
 * EzPin lists multiple SKUs per brand+country (denomination/variant rows), so we
 * group by canon|country → ONE merchant per group with all its SKUs as ezpin
 * discounts (fixes the "name already exists" dupes from per-SKU creates).
 *
 * Sellable filter (no explicit disabled field): currency in USD/GBP/CAD/EUR,
 * country in CTX's create-set, percentage_of_buying_price < 0 (real discount), not test.
 * Dedup: skip SKUs already linked; canon|country match an ENABLED merchant → link the
 * new SKUs, else create with all SKUs.
 * Env CTX_TOKEN. Flags: --dry-run --limit N --only <canon|country> --action create|link
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
const DONE_FILE = '/tmp/ezpin-allocate-done.json';
// Country → merchant currency, mirroring spend-api internal/merchant_currencies.go.
// CTX creates a merchant in the country's currency, so a product's merchant must
// use the country whose currency equals the product's price currency. Covers the
// full supplier-currency set (every EzPin geography), not just US/GB/CA/EUR.
const COUNTRY_CCY = {
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  FR: 'EUR',
  DE: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  FI: 'EUR',
  PT: 'EUR',
  GR: 'EUR',
  LU: 'EUR',
  SK: 'EUR',
  SI: 'EUR',
  LT: 'EUR',
  LV: 'EUR',
  EE: 'EUR',
  CY: 'EUR',
  MT: 'EUR',
  HR: 'EUR',
  MX: 'MXN',
  PE: 'PEN',
  CO: 'COP',
  CL: 'CLP',
  AE: 'AED',
  DK: 'DKK',
  SE: 'SEK',
  AU: 'AUD',
  SA: 'SAR',
  EG: 'EGP',
  PL: 'PLN',
  ZA: 'ZAR',
  TR: 'TRY',
  KW: 'KWD',
  OM: 'OMR',
  QA: 'QAR',
  NZ: 'NZD',
  BH: 'BHD',
  IN: 'INR',
  JO: 'JOD',
  CH: 'CHF',
  TH: 'THB',
  BR: 'BRL',
  TW: 'TWD',
  SG: 'SGD',
  ID: 'IDR',
  CZ: 'CZK',
  IQ: 'IQD',
  DZ: 'DZD',
};
const ALL_CCY = new Set(Object.values(COUNTRY_CCY));
// currency → canonical country (first country listed for that currency).
const CCY_TO_CTRY = {};
for (const [c, cur] of Object.entries(COUNTRY_CCY)) if (!CCY_TO_CTRY[cur]) CCY_TO_CTRY[cur] = c;
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

function ezpinDiscount(p) {
  const pct = Number(p.percentage_of_buying_price);
  if (!(pct < 0)) return null;
  const cur = p.currency?.code;
  if (!cur || !ALL_CCY.has(cur)) return null;
  const region = (p.regions || [])[0]?.code;
  // Use the product's region when its currency matches the merchant currency it
  // would create (AE→AED, DE→EUR); else the canonical country for the currency,
  // so a USD-priced "PlayStation Oman" becomes a US/USD merchant, not OM/OMR.
  const country = region && COUNTRY_CCY[region] === cur ? region : CCY_TO_CTRY[cur];
  if (!country) return null;
  const min = p.min_price,
    max = p.max_price;
  if (!(Number(min) >= 0) || !(Number(max) > 0)) return null;
  return {
    provider: 'ezpin',
    providerId: String(p.sku),
    countries: [country],
    currencies: [cur],
    denominationType: 'min-max',
    denominationValues: [String(min), String(max)],
    amountBasisPoints: Math.round(-pct * 100),
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
  const catalogs = JSON.parse(readFileSync('/tmp/ezpin-catalogs.json', 'utf8'));
  const ezpinIdsInUse = new Set();
  for (const m of merchants) {
    if (m.status && m.status !== 'enabled') continue;
    for (const d of m.discounts || [])
      if (String(d.provider).toLowerCase() === 'ezpin' && d.providerId)
        ezpinIdsInUse.add(String(d.providerId));
  }
  const idx = new Map();
  for (const m of merchants) {
    if (m.status && m.status !== 'enabled') continue;
    idx.set(`${canon(m.name)}|${m.country}`, m);
  }
  // Group sellable products by canon|country → one merchant per group.
  const groups = new Map();
  for (const p of catalogs) {
    const title = String(p.title || '').trim();
    if (!title || /test/i.test(title)) continue;
    const disc = ezpinDiscount(p);
    if (!disc) continue;
    if (ezpinIdsInUse.has(String(p.sku))) continue;
    const key = `${canon(title)}|${disc.countries[0]}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: title, country: disc.countries[0], currency: disc.currencies[0], discs: [] };
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
              String(e.provider).toLowerCase() === 'ezpin' &&
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
  console.log(`EzPin plan: ${plan.length} (${JSON.stringify(counts)})${DRY ? ' — DRY' : ''}\n`);

  let ok = 0,
    fail = 0;
  for (const p of plan) {
    try {
      const rep = p.discs[0];
      if (DRY) {
        console.log(
          `  [${p.action}] ${p.name} [${p.country} ${p.currency}] skus:${p.discs.length} ${rep.amountBasisPoints}bps`,
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
        console.log(
          `  ✓ create ${p.name.slice(0, 28).padEnd(28)} ${id} ${p.currency} skus:${p.discs.length}`,
        );
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
        console.log(`  ✓ link   ${p.name.slice(0, 28).padEnd(28)} +ezpin×${p.discs.length}`);
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
