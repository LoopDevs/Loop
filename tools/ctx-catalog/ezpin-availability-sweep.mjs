#!/usr/bin/env node
/**
 * EzPin availability sweep — proactively disable/trim out-of-stock + inactive ezpin
 * merchants (EzPin omits stock from the catalogue; the only signal is the per-product
 * availability endpoint — see spend-api#4).
 *
 *   GET {EZB}/catalogs/{sku}/availability/?item_count=1&price=P
 *     → delivery_type: 0 = out of stock / inactive, 1/2/3 = available
 *
 * Phase 1 (default): auth EzPin + check availability for every ezpin sku on our enabled
 *   merchants, cached + resumable to /tmp/ezpin-avail.json. Uses the EzPin vendor key
 *   (/tmp/ezpin-client-id.txt + /tmp/ezpin-key.txt), whitelisted IP.
 * Phase 2 (--apply): drop ezpin discounts whose sku is out of stock / inactive; keep the
 *   merchant if it has another good supplier, else disable it. Uses the CTX admin token.
 *   --dry-run reports without writing.
 *
 * Stock is transient, so re-run periodically; the spend-api#4 order-time guard is the
 * always-on safety net.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = args.includes('--dry-run');
const CACHE = '/tmp/ezpin-avail.json';
const EZB = 'https://api.ezpaypin.com/vendors/v2';
const CTXB = 'https://spend.ctx.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const all = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const catMin = {};
for (const p of JSON.parse(readFileSync('/tmp/ezpin-catalogs.json', 'utf8')))
  catMin[String(p.sku)] = p.min_price;

// sku → representative price (merchant discount min denomination, else catalog min, else 10)
const skuPrice = {};
for (const m of all) {
  if (m.status !== 'enabled') continue;
  for (const d of m.discounts || []) {
    if (String(d.provider).toLowerCase() !== 'ezpin' || !d.providerId) continue;
    const sku = String(d.providerId);
    if (skuPrice[sku]) continue;
    skuPrice[sku] = (d.denominationValues || [])[0] || catMin[sku] || 10;
  }
}
const skus = Object.keys(skuPrice);
let cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

async function ezAuth() {
  const cid = readFileSync('/tmp/ezpin-client-id.txt', 'utf8').trim();
  const sk = readFileSync('/tmp/ezpin-key.txt', 'utf8').trim();
  const r = await fetch(EZB + '/auth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cid, secret_key: sk }),
  });
  if (!r.ok) throw new Error('ezpin auth ' + r.status + ' ' + (await r.text()).slice(0, 80));
  return (await r.json()).access;
}

async function checkPhase() {
  let access = await ezAuth();
  let H = { Authorization: 'Bearer ' + access };
  let checked = 0,
    already = skus.filter((s) => cache[s] !== undefined).length;
  console.log(`checking ${skus.length} skus (${already} cached)...`);
  for (const sku of skus) {
    if (cache[sku] !== undefined) continue;
    const price = skuPrice[sku];
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const r = await fetch(
          `${EZB}/catalogs/${sku}/availability/?item_count=1&price=${encodeURIComponent(price)}`,
          { headers: H },
        );
        if (r.status === 401) {
          access = await ezAuth();
          H = { Authorization: 'Bearer ' + access };
          continue;
        }
        if (r.status === 429 || r.status >= 500) {
          await sleep(3000 * (attempt + 1));
          continue;
        }
        const j = await r.json().catch(() => ({}));
        cache[sku] = { dt: j.delivery_type, av: j.availability, detail: j.detail };
        ok = true;
      } catch (e) {
        await sleep(1500 * (attempt + 1));
      }
    }
    checked++;
    if (checked % 20 === 0) {
      writeFileSync(CACHE, JSON.stringify(cache));
      console.log(`  +${checked} (${already + checked}/${skus.length})`);
    }
    await sleep(800);
  }
  writeFileSync(CACHE, JSON.stringify(cache));
  const dist = {};
  for (const s of skus) {
    const c = cache[s];
    const k = !c ? 'unchecked' : c.dt === 0 ? 'OUT/inactive' : 'available';
    dist[k] = (dist[k] || 0) + 1;
  }
  console.log('Done checking. distribution:', JSON.stringify(dist));
}

async function applyPhase() {
  const T = (process.env.CTX_TOKEN ?? readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
  const H = {
    Authorization: `Bearer ${T}`,
    'x-client-id': 'ctx_admin',
    'Content-Type': 'application/json',
  };
  const dead = (d) =>
    String(d.provider).toLowerCase() === 'ezpin' &&
    cache[String(d.providerId)] &&
    cache[String(d.providerId)].dt === 0;
  const affected = all.filter((m) => m.status === 'enabled' && (m.discounts || []).some(dead));
  console.log(
    `${affected.length} enabled merchants have an out-of-stock/inactive ezpin discount${DRY ? ' (DRY)' : ''}`,
  );
  let trimmed = 0,
    disabled = 0,
    fail = 0;
  for (const m of affected) {
    const good = (m.discounts || []).filter((d) => !dead(d));
    try {
      if (DRY) {
        console.log(
          `  [${good.length ? 'trim' : 'DISABLE'}] ${m.name} — drop ${m.discounts.length - good.length} ezpin`,
        );
        continue;
      }
      let r;
      if (good.length > 0)
        r = await fetch(`${CTXB}/merchants/${m.id}`, {
          method: 'PUT',
          headers: H,
          body: JSON.stringify({ id: m.id, discounts: good }),
        });
      else
        r = await fetch(`${CTXB}/merchants/${m.id}`, {
          method: 'PUT',
          headers: H,
          body: JSON.stringify({
            id: m.id,
            status: 'disabled',
            statusReason: 'administrator_error',
            statusNote: 'ezpin out of stock / inactive (availability delivery_type 0)',
          }),
        });
      if (r.ok) {
        good.length ? trimmed++ : disabled++;
        console.log(`  ✓ ${good.length ? 'trim' : 'DISABLE'} ${m.name}`);
      } else {
        fail++;
        console.log(`  ✗ ${m.name} → ${r.status} ${(await r.text()).slice(0, 70)}`);
      }
      await sleep(400);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${m.name} ${e.message}`);
    }
  }
  console.log(`\ntrimmed:${trimmed} disabled:${disabled} fail:${fail}`);
}

if (APPLY || DRY) await applyPhase();
else await checkPhase();
