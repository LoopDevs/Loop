#!/usr/bin/env node
/**
 * Create new merchants for genuine cross-card group siblings and link each
 * to the family cross-card product, so it's purchasable (we fulfil via the
 * cross-card). POST /merchants {name,country} → PUT discounts + enable.
 *
 * Reads a plan: [{ name, country, link:[{provider,providerId}] }].
 * Env CTX_TOKEN. Flags: --plan <file> --dry-run --only "<name>" --limit N
 * Additive + reversible (created merchants can be disabled).
 */
import { readFileSync, writeFileSync } from 'node:fs';

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
const ONLY = val('--only');
const LIMIT = val('--limit') ? Number(val('--limit')) : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ctxFetch(url, opts, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, opts);
    if (r.status === 429) {
      await sleep(2000 * (i + 1));
      continue;
    }
    return r;
  }
  throw new Error('rate-limited');
}

async function main() {
  if (!TOKEN) {
    console.error('CTX_TOKEN not set');
    process.exit(2);
  }

  let plan = JSON.parse(readFileSync(val('--plan'), 'utf8')).filter((p) => p.link && p.link.length);
  if (ONLY) plan = plan.filter((p) => p.name === ONLY);
  plan = plan.slice(0, LIMIT === Infinity ? plan.length : LIMIT);
  console.log(`Create + link: ${plan.length}${DRY ? ' (dry-run)' : ''}\n`);
  const created = [];
  for (const p of plan) {
    try {
      if (DRY) {
        console.log(
          `  [dry] create "${p.name}" [${p.country}] → link [${p.link.map((d) => d.provider + ':' + d.providerId).join(', ')}]`,
        );
        continue;
      }
      // 1) create
      const cr = await ctxFetch(`${BASE}/merchants`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ name: p.name, country: p.country }),
      });
      const cj = await cr.json().catch(() => ({}));
      if (!cr.ok) {
        console.log(`  ✗ ${p.name} create → ${cr.status}: ${JSON.stringify(cj).slice(0, 120)}`);
        continue;
      }
      const id = cj.id || cj.Id;
      await sleep(700);
      // 2) configure: link cross-card product(s) + enable
      const put = { id, discounts: p.link, status: 'enabled' };
      if (p.denominationType) put.denominationType = p.denominationType;
      if (p.denominationValues) put.denominationValues = p.denominationValues;
      if (p.userDiscount != null) put.userDiscount = p.userDiscount;
      const pr = await ctxFetch(`${BASE}/merchants/${id}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify(put),
      });
      const pj = await pr.json().catch(() => ({}));
      if (!pr.ok) {
        console.log(
          `  ⚠ ${p.name} created (${id}) but link failed → ${pr.status}: ${JSON.stringify(pj).slice(0, 140)}`,
        );
        continue;
      }
      console.log(
        `  ✓ ${p.name.padEnd(24)} ${id}  discounts:[${(pj.discounts || []).map((d) => d.provider + ':' + d.providerId).join(',')}]  denom:${pj.denominationType || '-'}  userDiscount:${pj.userDiscount ?? '-'}`,
      );
      created.push({ id, ...p });
      await sleep(700);
    } catch (e) {
      console.log(`  ✗ ${p.name} ${e.message}`);
    }
  }
  if (!DRY) writeFileSync('/tmp/ctx-created.json', JSON.stringify(created, null, 2));
  console.log(`\nCreated ${created.length}.`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
