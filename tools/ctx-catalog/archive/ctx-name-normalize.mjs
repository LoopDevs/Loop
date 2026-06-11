#!/usr/bin/env node
/**
 * Comprehensive merchant-name normalizer → "Brand <FullCountryName>" (US/UK keep
 * the code, per the naming decision). Handles, in priority order:
 *   - domain/TLD names:  Amazon.com.tr → Amazon Turkey, Amazon.com.au → Amazon
 *     Australia, allmodern.com → AllModern <country>, 1-800-Flowers.com → …
 *   - embedded domains:  43einhalb.com Germany → 43einhalb Germany
 *   - country-code suffix: adidas FR → adidas France, …USA → … US
 * Country comes from a country TLD when present, else the merchant's country.
 * Collisions with an existing tile are reported as merges (pool + disable), not
 * blind renames. Codifies the human-review naming findings.
 *   node scripts/ctx-name-normalize.mjs [--apply]
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
// trailing country CODE token → ISO2
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
  IE: 'IE',
  AT: 'AT',
  PT: 'PT',
  FI: 'FI',
  GR: 'GR',
  CA: 'CA',
  CH: 'CH',
  SE: 'SE',
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
// ccTLD → ISO2
const TLD = {
  tr: 'TR',
  au: 'AU',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  be: 'BE',
  nl: 'NL',
  ie: 'IE',
  at: 'AT',
  pt: 'PT',
  fi: 'FI',
  gr: 'GR',
  ca: 'CA',
  ch: 'CH',
  se: 'SE',
  dk: 'DK',
  no: 'NO',
  pl: 'PL',
  cz: 'CZ',
  mx: 'MX',
  ae: 'AE',
  sa: 'SA',
  in: 'IN',
  nz: 'NZ',
  uk: 'GB',
};

const suffixFor = (iso) => NAME[iso] || iso;
const lc = (s) => s.toLowerCase();

function normalize(m) {
  let name = m.name.trim();
  let iso = null;
  // 1) domain / TLD anywhere in the token soup
  const dm = name.match(
    /^(.*?)\s*\b([a-z0-9-]+)\.(com|net|org|co|shop|io|tv|me|it|nl|de|fr|es|be|at|pt|fi|gr|ca|ch|se|dk|no|pl|cz|mx|ae|sa|au|nz|tr|uk)(\.([a-z]{2}))?\b\s*(.*)$/i,
  );
  if (dm) {
    const brand = (dm[1] + ' ' + dm[2]).trim().replace(/\s+/g, ' ');
    const ccTld = (dm[5] && TLD[lc(dm[5])]) || TLD[lc(dm[3])];
    const trailing = (dm[6] || '').trim(); // e.g. "Germany" in "43einhalb.com Germany"
    iso = ccTld || (trailing && trailFromName(trailing)) || m.country;
    return `${brand} ${suffixFor(iso)}`.trim();
  }
  // 2) trailing country CODE
  const cm = name.match(/^(.*?)[\s-]+([A-Z]{2,3})$/);
  if (cm && CODE[cm[2]]) {
    iso = CODE[cm[2]];
    const brand = cm[1].replace(/[\s-]+$/, '').trim();
    if (brand) return `${brand} ${suffixFor(iso)}`;
  }
  return null;
}
function trailFromName(t) {
  const k = Object.entries(NAME).find(([, v]) => lc(v) === lc(t));
  return k ? k[0] : null;
}

const enabledNames = new Set(en.map((m) => lc(m.name)));
const renames = [],
  merges = [];
for (const m of en) {
  const nn = normalize(m);
  if (!nn || nn === m.name || nn.length < 2) continue;
  if (enabledNames.has(lc(nn))) merges.push({ from: m, newName: nn });
  else renames.push({ id: m.id, old: m.name, new: nn });
}
console.log(
  `Name normalize: ${renames.length} renames, ${merges.length} collisions→merge${APPLY ? '' : ' — DRY RUN'}`,
);
console.log('--- sample renames ---');
renames.slice(0, 30).forEach((r) => console.log(`  "${r.old}"  →  "${r.new}"`));
if (merges.length) {
  console.log('--- collisions (merge into existing) ---');
  merges.slice(0, 12).forEach((x) => console.log(`  "${x.from.name}" → existing "${x.newName}"`));
}
if (!APPLY) {
  console.log('\n(dry-run — re-run with --apply)');
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
const q = [...renames];
async function worker() {
  while (q.length) {
    const p = q.shift();
    const r = await put(p.id, { name: p.new });
    if (r === true) ok++;
    else fail++;
    if ((ok + fail) % 80 === 0) process.stdout.write(`\r  ${ok + fail}/${renames.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
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
  if (
    (await put(tgt.id, { discounts: pooled })) === true &&
    (await put(x.from.id, {
      status: 'disabled',
      statusReason: 'other',
      statusNote: 'merged → ' + x.newName,
    })) === true
  )
    mOk++;
}
console.log(`\nApplied — renames ${ok}, merges ${mOk}, fail ${fail}`);
