#!/usr/bin/env node
/**
 * Pull the full EzPin catalogue (/system/ezpin/catalogs, paginated limit/offset
 * with a `count` envelope) into /tmp/ezpin-catalogs.json as a flat array — the
 * shape ezpin-allocate.mjs consumes. Standalone re-pull (supplier-pull only
 * fetches retailer-products, a different endpoint). Env CTX_TOKEN or token file.
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

const limit = 500;
let offset = 0;
let count = Infinity;
const all = [];
while (offset < count) {
  const d = await getJson(
    `https://spend.ctx.com/system/ezpin/catalogs?limit=${limit}&offset=${offset}`,
  );
  count = d.count ?? all.length;
  const rows = d.results || d.result || [];
  all.push(...rows);
  process.stdout.write(`\r  ezpin catalogs: ${all.length}/${count}`);
  offset += limit;
  if (!rows.length) break;
}
writeFileSync('/tmp/ezpin-catalogs.json', JSON.stringify(all));
console.log(`\n  wrote /tmp/ezpin-catalogs.json (${all.length} items)`);
