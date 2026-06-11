#!/usr/bin/env node
/**
 * Pull /system/ezpin/retailer-products (the EAN/product_code-keyed catalogue —
 * distinct from /system/ezpin/catalogs which is sku-keyed) into
 * /tmp/ezpin-retailer-products.json, then report how many of the 502
 * unresolved merchant discounts these cover.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const T = (process.env.CTX_TOKEN || readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
const H = { Authorization: `Bearer ${T}`, 'x-client-id': 'ctx_admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(40000) });
      if (r.status === 429 || r.status >= 500) {
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    } catch (e) {
      if (i === 7) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

const all = [];
let offset = 0,
  count = Infinity;
while (offset < count) {
  const d = await getJson(
    `https://spend.ctx.com/system/ezpin/retailer-products?limit=500&offset=${offset}`,
  );
  count = d.count ?? all.length;
  const rows = d.results || d.result || [];
  all.push(...rows);
  process.stdout.write(`\r  retailer-products: ${all.length}/${count}`);
  offset += 500;
  if (!rows.length) break;
}
writeFileSync('/tmp/ezpin-retailer-products.json', JSON.stringify(all));
console.log(`\n  wrote ${all.length} retailer-products`);
console.log('  sample row:', JSON.stringify(all[0]).slice(0, 260));

const rp = new Map();
for (const p of all) {
  const code = String(p.product_code || p.product?.product_code || '');
  const title = p.product?.name || p.product?.title || p.name || '';
  if (code) rp.set(code, title);
}
const cat = new Set(
  JSON.parse(readFileSync('/tmp/ezpin-catalogs.json', 'utf8')).map((p) => String(p.sku)),
);
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const seen = new Set();
let resolved = 0;
const stillMissing = [];
for (const m of M.filter((x) => x.status === 'enabled')) {
  for (const d of m.discounts || []) {
    if (d.provider !== 'ezpin') continue;
    const pid = String(d.providerId);
    if (cat.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    if (rp.has(pid)) resolved++;
    else stillMissing.push(pid);
  }
}
console.log(
  `  502 re-check → resolved by retailer-products: ${resolved} | still truly missing: ${stillMissing.length}`,
);
console.log('  still-missing sample:', stillMissing.slice(0, 8).join(', '));
