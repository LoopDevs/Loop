#!/usr/bin/env node
/**
 * Pull the full catalogue of all three suppliers (via CTX's /system/* endpoints)
 * plus the current Loop merchants, into /tmp for the de-duplicated sync (goal:
 * sync all Tillo/SVS/EzPin merchants into CTX, de-duplicated).
 *
 *   Tillo  GET /system/tillo/brands           (paginated page/perPage)
 *   EzPin  GET /system/ezpin/retailer-products (paginated limit/offset, count)
 *   SVS    GET /system/svs/products           (paginated page/perPage)
 *   Loop   GET /merchants                     (paginated page/perPage)
 *
 * Env CTX_TOKEN (raw).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://spend.ctx.com';
const T = process.env.CTX_TOKEN || readFileSync('/tmp/ctx-token.txt', 'utf8').trim();
const H = { Authorization: `Bearer ${T}`, 'x-client-id': 'ctx_admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(BASE + path, { headers: H });
    if (r.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  }
  throw new Error('rate-limited');
}

// page/perPage pagination (Tillo, SVS, Loop) — result key varies.
async function pagePaginate(path, resultKey) {
  let page = 1,
    pages = 1,
    out = [];
  while (page <= pages) {
    const sep = path.includes('?') ? '&' : '?';
    const d = await getJson(`${path}${sep}page=${page}&perPage=200`);
    pages = d.pagination?.pages ?? 1;
    out.push(...(d[resultKey] || d.result || d.results || []));
    page++;
  }
  return out;
}

// limit/offset pagination (EzPin) — uses `count`.
async function offsetPaginate(path) {
  let offset = 0,
    out = [],
    count = Infinity;
  while (out.length < count) {
    const sep = path.includes('?') ? '&' : '?';
    const d = await getJson(`${path}${sep}limit=200&offset=${offset}`);
    count = d.count ?? out.length;
    const res = d.results || [];
    if (!res.length) break;
    out.push(...res);
    offset += 200;
  }
  return out;
}

const tillo = JSON.parse(readFileSync('/tmp/tillo-brands.json', 'utf8')); // already cached
const ezpin = await offsetPaginate('/system/ezpin/retailer-products');
const svs = await pagePaginate('/system/svs/products', 'result');
const loop = await pagePaginate('/merchants', 'result');

writeFileSync('/tmp/ezpin-products.json', JSON.stringify(ezpin));
writeFileSync('/tmp/svs-products.json', JSON.stringify(svs));
writeFileSync('/tmp/ctx-fresh.json', JSON.stringify(loop));

console.log('Pulled:');
console.log('  Tillo brands     :', tillo.length, '(cached)');
console.log('  EzPin products   :', ezpin.length);
console.log('  SVS products     :', svs.length);
console.log('  Loop merchants   :', loop.length);
