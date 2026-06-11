#!/usr/bin/env node
/**
 * Naming convention: per-country merchants use the full country NAME, except US/UK
 * which keep the 2-letter code (user decision). Converts an UPPERCASE trailing
 * country CODE suffix → full name: "adidas FR" → "adidas France", "adidas DE" →
 * "adidas Germany"; "adidas US"/"adidas UK" unchanged. Only acts on uppercase code
 * tokens (so "Air France"/"Bank of America" are untouched). Collisions with an
 * existing tile are reported as merges, not blind renames.
 *   node scripts/ctx-name-convention.mjs [--apply]
 */
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const BASE = 'https://spend.ctx.com';
const TOKEN = (process.env.CTX_TOKEN ?? readFileSync('/tmp/ctx-token.txt', 'utf8')).trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};
const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const en = M.filter((m) => m.status === 'enabled');

// trailing code token → ISO2
const CODE = {
  FR: 'FR',
  DE: 'DE',
  DEU: 'DE',
  ES: 'ES',
  ESP: 'ES',
  IT: 'IT',
  ITA: 'IT',
  BE: 'BE',
  NL: 'NL',
  NLD: 'NL',
  IE: 'IE',
  IRL: 'IE',
  AT: 'AT',
  AUT: 'AT',
  PT: 'PT',
  PRT: 'PT',
  FI: 'FI',
  FIN: 'FI',
  GR: 'GR',
  GRC: 'GR',
  CA: 'CA',
  CAN: 'CA',
  CH: 'CH',
  SE: 'SE',
  SWE: 'SE',
  DK: 'DK',
  NO: 'NO',
  PL: 'PL',
  CZ: 'CZ',
  LU: 'LU',
  MX: 'MX',
  AE: 'AE',
  UAE: 'AE',
  SA: 'SA',
  KSA: 'SA',
  IN: 'IN',
  AU: 'AU',
  NZ: 'NZ',
  QA: 'QA',
  KW: 'KW',
  BH: 'BH',
  OM: 'OM',
  EG: 'EG',
  ZA: 'ZA',
  TR: 'TR',
  HR: 'HR',
  US: 'US',
  USA: 'US',
  GB: 'GB',
  GBR: 'GB',
  UK: 'GB',
};
// ISO2 → full display name (US/UK stay as code per the user)
const NAME = {
  FR: 'France',
  DE: 'Germany',
  ES: 'Spain',
  IT: 'Italy',
  BE: 'Belgium',
  NL: 'Netherlands',
  IE: 'Ireland',
  AT: 'Austria',
  PT: 'Portugal',
  FI: 'Finland',
  GR: 'Greece',
  CA: 'Canada',
  CH: 'Switzerland',
  SE: 'Sweden',
  DK: 'Denmark',
  NO: 'Norway',
  PL: 'Poland',
  CZ: 'Czechia',
  LU: 'Luxembourg',
  MX: 'Mexico',
  AE: 'UAE',
  SA: 'Saudi Arabia',
  IN: 'India',
  AU: 'Australia',
  NZ: 'New Zealand',
  QA: 'Qatar',
  KW: 'Kuwait',
  BH: 'Bahrain',
  OM: 'Oman',
  EG: 'Egypt',
  ZA: 'South Africa',
  TR: 'Turkey',
  HR: 'Croatia',
  US: 'US',
  GB: 'UK',
};

const lc = (s) => s.toLowerCase();
const enabledNames = new Set(en.map((m) => lc(m.name)));
const plan = [],
  merges = [];
for (const m of en) {
  const mt = m.name.match(/^(.*?)[\s-]+([A-Z]{2,3})$/); // brand + trailing UPPERCASE code
  if (!mt) continue;
  const iso = CODE[mt[2]];
  if (!iso) continue;
  const brand = mt[1].replace(/[\s-]+$/, '').trim();
  if (!brand) continue;
  const suffix = NAME[iso];
  const newName = `${brand} ${suffix}`;
  if (newName === m.name) continue;
  if (enabledNames.has(lc(newName))) merges.push({ from: m, newName });
  else plan.push({ id: m.id, old: m.name, new: newName });
}
console.log(
  `Naming convention: ${plan.length} renames, ${merges.length} collisions→merge${APPLY ? '' : ' — DRY RUN'}`,
);
plan.slice(0, 20).forEach((p) => console.log(`  "${p.old}" → "${p.new}"`));
if (merges.length) {
  console.log('Collisions (would merge into existing):');
  merges.slice(0, 10).forEach((x) => console.log(`  "${x.from.name}" → existing "${x.newName}"`));
}
if (!APPLY) {
  console.log('\n(dry-run)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function put(id, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${BASE}/merchants/${id}`, {
        method: 'PUT',
        headers: H,
        body: JSON.stringify({ id, ...body }),
        signal: AbortSignal.timeout(40000),
      });
      if (r.ok) return true;
      if (r.status >= 500 || r.status === 429) {
        await sleep(1500 * (i + 1));
        continue;
      }
      return { err: r.status };
    } catch (e) {
      if (i === 3) return { err: String(e.message) };
      await sleep(1500);
    }
  }
}
let ok = 0,
  fail = 0;
const q = [...plan];
async function worker() {
  while (q.length) {
    const p = q.shift();
    const r = await put(p.id, { name: p.new });
    if (r === true) ok++;
    else fail++;
    if ((ok + fail) % 80 === 0) process.stdout.write(`\r  ${ok + fail}/${plan.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
// merges: pool providers onto the existing target, disable the coded one
let mOk = 0;
const byName = new Map(en.map((m) => [lc(m.name), m]));
for (const x of merges) {
  const tgt = byName.get(lc(x.newName));
  if (!tgt) continue;
  const seen = new Set(),
    pooled = [];
  for (const mm of [tgt, x.from])
    for (const d of mm.discounts || []) {
      const k = d.provider + ':' + d.providerId;
      if (!seen.has(k)) {
        seen.add(k);
        pooled.push({ provider: d.provider, providerId: d.providerId });
      }
    }
  const r = await put(tgt.id, { discounts: pooled });
  if (r === true) {
    const r2 = await put(x.from.id, {
      status: 'disabled',
      statusReason: 'other',
      statusNote: 'merged → ' + x.newName,
    });
    if (r2 === true) mOk++;
  }
}
console.log(`\nApplied — renames ${ok}, merges ${mOk}, fail ${fail}`);
