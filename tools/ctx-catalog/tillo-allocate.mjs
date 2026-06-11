#!/usr/bin/env node
/**
 * Allocate Tillo brands → Loop merchants (2026-06-08, after the brand re-sync).
 *
 *  - NEW brand (no existing merchant at base-name|country|currency)
 *      → POST /merchants {name,country} → PUT {discounts:[tillo], denoms, userDiscount, status:enabled}
 *  - EXISTING brand we already list but WITHOUT a tillo discount
 *      → GET merchant → PUT {discounts:[...existing, tillo]}  (append for redundancy + best-rate;
 *        CTX picks the highest amountBasisPoints at order time and falls back if a provider is down)
 *
 * Link key: discount.providerId = tillo brand slug (verified against existing tillo merchants).
 * Resumable: records done slugs in /tmp/tillo-allocate-done.json and skips them.
 *
 * Env CTX_TOKEN (raw, no "Bearer "). Flags:
 *   --dry-run            print actions, no writes
 *   --action create|link only one phase
 *   --limit N            cap items
 *   --only <slug>        single brand
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://spend.ctx.com';
const TOKEN = process.env.CTX_TOKEN;
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
const DONE_FILE = '/tmp/tillo-allocate-done.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EU = new Set([
  'DE',
  'FR',
  'IE',
  'ES',
  'IT',
  'NL',
  'BE',
  'AT',
  'PT',
  'FI',
  'GR',
  'LU',
  'SK',
  'SI',
  'EE',
  'LV',
  'LT',
  'CY',
  'MT',
  'PL',
  'SE',
  'DK',
  'CZ',
  'HU',
  'RO',
  'BG',
  'HR',
]);
// Strong canonical brand key — drops TLDs (.com/.co.uk/…), country words, and
// gift-card words so format variants unify (e.g. "1-800-Baskets.com USA" ↔
// "1-800-Baskets", "Apple Gift Cards US" ↔ "Apple US"). This is the fix for the
// dedup gap that duplicated 1-800-Baskets / 1-800-PetSupplies.
const base = (s) =>
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
const primaryCountry = (b) => (b.countries_served || [])[0] || '';

/** Build the tillo discount entry for a brand. Returns null if denominations are unmappable. */
function tilloDiscount(b) {
  const bps = Math.round(Number(b.discount) * 100);
  if (!Number.isFinite(bps)) return null;
  let denominationType, denominationValues;
  const fvl = b.digital_face_value_limits;
  if (fvl && fvl.lower && fvl.upper) {
    denominationType = 'min-max';
    denominationValues = [fvl.lower, fvl.upper];
  } else if (Array.isArray(b.digital_denominations) && b.digital_denominations.length) {
    denominationType = 'fixed';
    denominationValues = b.digital_denominations;
  } else {
    return null; // the 5 with neither
  }
  return {
    provider: 'tillo',
    providerId: b.slug,
    countries: [primaryCountry(b)],
    currencies: [b.currency],
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
      // network/connection error (fetch threw) — the 554 "fetch failed" in the first
      // run were these. Retry with backoff instead of failing the item permanently.
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr || new Error('rate-limited');
}

function buildPlan() {
  const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
  const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8'));
  // PRIMARY dedup: a brand already allocated has its slug as a tillo providerId on
  // some merchant. This catches format/word-order mismatches the name-match misses
  // (e.g. "Aberdeen Gift Card - Town & City Gift Cards" ↔ "Town & City Gift Cards - Aberdeen").
  const tilloSlugsInUse = new Set();
  for (const m of merchants) {
    if (m.status && m.status !== 'enabled') continue;
    for (const d of m.discounts || [])
      if (String(d.provider).toLowerCase() === 'tillo' && d.providerId)
        tilloSlugsInUse.add(d.providerId);
  }
  // Index ENABLED merchants by canon|country (currency follows country). Enabled-only
  // so disabled test-dupes are never link targets and a brand matching only a disabled
  // merchant still resolves to the real enabled one.
  const idx = new Map();
  for (const m of merchants) {
    if (m.status && m.status !== 'enabled') continue;
    idx.set(`${base(m.name)}|${m.country}`, m);
  }

  const plan = [];
  for (const b of tillo) {
    if (tilloSlugsInUse.has(b.slug)) continue; // already allocated to a merchant — skip
    const disc = tilloDiscount(b);
    if (!disc) continue;
    const m = idx.get(`${base(b.name)}|${primaryCountry(b)}`);
    if (!m) {
      plan.push({
        action: 'create',
        slug: b.slug,
        name: b.name,
        country: primaryCountry(b),
        currency: b.currency,
        disc,
      });
    } else if (!(m.discounts || []).some((d) => String(d.provider).toLowerCase() === 'tillo')) {
      plan.push({
        action: 'link',
        slug: b.slug,
        name: m.name,
        id: m.id,
        existing: m.discounts || [],
        disc,
      });
    } // else already tillo-linked → skip
  }
  return plan;
}

async function main() {
  if (!TOKEN) {
    console.error('CTX_TOKEN not set');
    process.exit(2);
  }
  const done = new Set(existsSync(DONE_FILE) ? JSON.parse(readFileSync(DONE_FILE, 'utf8')) : []);
  let plan = buildPlan().filter((p) => !done.has(p.slug));
  if (ACTION) plan = plan.filter((p) => p.action === ACTION);
  if (ONLY) plan = plan.filter((p) => p.slug === ONLY);
  plan = plan.slice(0, LIMIT === Infinity ? plan.length : LIMIT);

  const counts = plan.reduce((a, p) => ((a[p.action] = (a[p.action] || 0) + 1), a), {});
  console.log(`Plan: ${plan.length} (${JSON.stringify(counts)})${DRY ? ' — DRY RUN' : ''}\n`);

  let ok = 0,
    fail = 0;
  for (const p of plan) {
    try {
      if (DRY) {
        console.log(
          `  [${p.action}] ${p.name} [${p.country || ''} ${p.currency || ''}] tillo:${p.slug} ${p.disc.denominationType} ${JSON.stringify(p.disc.denominationValues)} ${p.disc.amountBasisPoints}bps`,
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
          console.log(`  ✗ create ${p.name} → ${cr.status} ${JSON.stringify(cj).slice(0, 100)}`);
          fail++;
          continue;
        }
        const id = cj.id || cj.Id;
        await sleep(600);
        // Merchant-level UserDiscount + DenominationValues are STRINGS (Go struct);
        // currency is derived server-side from country, so don't send it.
        const put = {
          id,
          discounts: [p.disc],
          denominationType: p.disc.denominationType,
          denominationValues: p.disc.denominationValues.join(','),
          userDiscount: String(p.disc.amountBasisPoints),
          status: 'enabled',
        };
        const pr = await ctxFetch(`${BASE}/merchants/${id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(put),
        });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) {
          console.log(
            `  ⚠ ${p.name} created ${id} but config failed → ${pr.status} ${JSON.stringify(pj).slice(0, 120)}`,
          );
          fail++;
          continue;
        }
        console.log(
          `  ✓ create ${p.name.slice(0, 30).padEnd(30)} ${id} ${pj.currency || '?'} disc:[${(pj.discounts || []).map((d) => d.provider).join(',')}] ${pj.userDiscount ?? '-'}bps`,
        );
        ok++;
      } else {
        const put = { id: p.id, discounts: [...p.existing, p.disc] };
        const pr = await ctxFetch(`${BASE}/merchants/${p.id}`, {
          method: 'PUT',
          headers: HEADERS,
          body: JSON.stringify(put),
        });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok) {
          console.log(`  ✗ link ${p.name} → ${pr.status} ${JSON.stringify(pj).slice(0, 120)}`);
          fail++;
          continue;
        }
        console.log(
          `  ✓ link   ${p.name.slice(0, 30).padEnd(30)} ${p.id} now:[${(pj.discounts || []).map((d) => d.provider).join(',')}]`,
        );
        ok++;
      }
      done.add(p.slug);
      if ((ok + fail) % 25 === 0) writeFileSync(DONE_FILE, JSON.stringify([...done]));
      await sleep(600);
    } catch (e) {
      console.log(`  ✗ ${p.name} ${e.message}`);
      fail++;
    }
  }
  writeFileSync(DONE_FILE, JSON.stringify([...done]));
  console.log(`\nDone. ok:${ok} fail:${fail} (total recorded done: ${done.size})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
