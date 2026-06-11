#!/usr/bin/env node
/**
 * Fresh from-scratch pull of the Tillo + SVS supplier catalogues into the files
 * the allocate scripts consume: /tmp/tillo-brands.json + /tmp/svs-products.json.
 * Both are page/perPage-paginated under a `result` key; written as flat arrays.
 * (supplier-pull.mjs treats tillo-brands.json as a pre-existing cache, so this
 * regenerates it cleanly.) Env CTX_TOKEN or token file.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const T = (process.env.CTX_TOKEN || readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
const H = { Authorization: `Bearer ${T}`, 'x-client-id': 'ctx_admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(40000) });
      if (r.status === 429 || r.status >= 500) {
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
      return r.json();
    } catch (e) {
      if (i === 5) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

async function pagePaginate(path) {
  let page = 1;
  let pages = 1;
  const out = [];
  while (page <= pages) {
    const sep = path.includes('?') ? '&' : '?';
    const d = await getJson(`https://spend.ctx.com${path}${sep}page=${page}&perPage=200`);
    pages = d.pagination?.pages ?? 1;
    out.push(...(d.result || []));
    process.stdout.write(`\r  ${path}: page ${page}/${pages} (${out.length})`);
    page++;
  }
  process.stdout.write('\n');
  return out;
}

const tillo = await pagePaginate('/system/tillo/brands');
writeFileSync('/tmp/tillo-brands.json', JSON.stringify(tillo));
console.log(`  wrote /tmp/tillo-brands.json (${tillo.length} brands)`);

const svs = await pagePaginate('/system/svs/products');
writeFileSync('/tmp/svs-products.json', JSON.stringify(svs));
console.log(`  wrote /tmp/svs-products.json (${svs.length} products)`);
