#!/usr/bin/env node
/**
 * Minimal re-pull of the full Loop merchant catalogue (/merchants, paginated)
 * into /tmp/ctx-fresh.json — the existing-merchant index the allocate scripts
 * dedup against. Lighter than recount.mjs (which also reads media/info maps
 * that may be absent). Run between supplier allocations so cross-supplier
 * creates see each other's new merchants. Env CTX_TOKEN or token file.
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

let page = 1;
let pages = 1;
const all = [];
while (page <= pages) {
  const d = await getJson(`https://spend.ctx.com/merchants?page=${page}&perPage=200`);
  pages = d.pagination?.pages ?? 1;
  all.push(...(d.result || []));
  page++;
}
writeFileSync('/tmp/ctx-fresh.json', JSON.stringify(all));
console.log(
  `  ctx-fresh: ${all.length} merchants (${all.filter((m) => m.status === 'enabled').length} enabled)`,
);
