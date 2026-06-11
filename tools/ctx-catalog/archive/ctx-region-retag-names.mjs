#!/usr/bin/env node
/**
 * Region-retag v2 — re-tag US/USD merchants whose name ends in a country NAME
 * (not just a 3-letter code, which ctx-region-retag.mjs already did). Catches the
 * Tinder/PlayStation/Steam region SKUs the dup-verify flagged ("Tinder 1MonthGold
 * Bahrain" tagged US → BH). Trailing 1- or 2-word country token, USD only, via the
 * CTX bulk-update (perPage as string). EMEA-pool / non-country suffixes are left.
 *   node scripts/ctx-region-retag-names.mjs [--apply]
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
const fold = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const ONE = {
  germany: 'DE',
  deutschland: 'DE',
  france: 'FR',
  spain: 'ES',
  espana: 'ES',
  italy: 'IT',
  italia: 'IT',
  belgium: 'BE',
  belgique: 'BE',
  netherlands: 'NL',
  nederland: 'NL',
  ireland: 'IE',
  austria: 'AT',
  portugal: 'PT',
  finland: 'FI',
  greece: 'GR',
  canada: 'CA',
  switzerland: 'CH',
  sweden: 'SE',
  denmark: 'DK',
  norway: 'NO',
  poland: 'PL',
  czechia: 'CZ',
  luxembourg: 'LU',
  mexico: 'MX',
  uae: 'AE',
  emirates: 'AE',
  ksa: 'SA',
  bahrain: 'BH',
  qatar: 'QA',
  kuwait: 'KW',
  oman: 'OM',
  egypt: 'EG',
  india: 'IN',
  australia: 'AU',
  turkey: 'TR',
  croatia: 'HR',
  algeria: 'DZ',
  brazil: 'BR',
  chile: 'CL',
  colombia: 'CO',
  indonesia: 'ID',
  iraq: 'IQ',
  jordan: 'JO',
  lebanon: 'LB',
  malaysia: 'MY',
  morocco: 'MA',
  peru: 'PE',
  philippines: 'PH',
  romania: 'RO',
  singapore: 'SG',
  thailand: 'TH',
  argentina: 'AR',
  israel: 'IL',
  japan: 'JP',
  vietnam: 'VN',
  ukraine: 'UA',
  hungary: 'HU',
  bulgaria: 'BG',
  slovakia: 'SK',
  slovenia: 'SI',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  cyprus: 'CY',
  malta: 'MT',
  iceland: 'IS',
  pakistan: 'PK',
  bangladesh: 'BD',
  nigeria: 'NG',
  kenya: 'KE',
  ecuador: 'EC',
  uruguay: 'UY',
  paraguay: 'PY',
  bolivia: 'BO',
  guatemala: 'GT',
  panama: 'PA',
  lebanonn: 'LB',
};
const TWO = {
  'hong kong': 'HK',
  'south africa': 'ZA',
  'south korea': 'KR',
  'saudi arabia': 'SA',
  'new zealand': 'NZ',
  'czech republic': 'CZ',
  'costa rica': 'CR',
  'puerto rico': 'PR',
  'el salvador': 'SV',
  'dominican republic': 'DO',
  'sri lanka': 'LK',
};
const MARKETS = new Set([
  'US',
  'GB',
  'CA',
  'FR',
  'DE',
  'IT',
  'ES',
  'NL',
  'IE',
  'BE',
  'AT',
  'FI',
  'PT',
  'GR',
  'LU',
  'SK',
  'SI',
  'LT',
  'LV',
  'EE',
  'CY',
  'MT',
  'HR',
  'AE',
  'IN',
  'SA',
  'AU',
  'MX',
]);

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const byDest = new Map();
for (const m of merchants) {
  if (m.country !== 'US' || m.currency !== 'USD') continue;
  const toks = fold(m.name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (toks.length < 2) continue;
  const two = toks.slice(-2).join(' ');
  let dest = TWO[two] || ONE[toks[toks.length - 1]];
  if (!dest || dest === 'US' || dest === m.country) continue;
  (byDest.get(dest) || byDest.set(dest, []).get(dest)).push(m);
}
let total = 0,
  toMarket = 0;
const rows = [...byDest.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`Name-based region-retag: ${rows.length} destinations${APPLY ? '' : ' — DRY RUN'}`);
for (const [d, l] of rows.slice(0, 16))
  console.log(
    `  → ${d}${MARKETS.has(d) ? ' (market)' : ' (hidden)'}: ${l.length}  e.g. ${l[0].name.slice(0, 40)}`,
  );
for (const [, l] of rows) {
  total += l.length;
}
for (const [d, l] of rows) if (MARKETS.has(d)) toMarket += l.length;
console.log(`Total: ${total} SKUs (${toMarket} into markets, ${total - toMarket} hidden)`);
if (!APPLY) {
  console.log('\n(dry-run)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0,
  fail = 0;
for (const [dest, list] of rows) {
  for (let i = 0; i < list.length; i += 120) {
    const ids = list
      .slice(i, i + 120)
      .map((m) => m.id)
      .join(',');
    for (let t = 0; t < 4; t++) {
      try {
        const r = await fetch(`${BASE}/merchants`, {
          method: 'PUT',
          headers: H,
          body: JSON.stringify({ filter: { ids, perPage: '500' }, country: dest }),
          signal: AbortSignal.timeout(60000),
        });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          ok += j.updated ?? list.slice(i, i + 120).length;
          break;
        }
        if (r.status >= 500 || r.status === 429) {
          await sleep(1500 * (t + 1));
          continue;
        }
        fail += list.slice(i, i + 120).length;
        break;
      } catch (e) {
        if (t === 3) fail += list.slice(i, i + 120).length;
        else await sleep(1500);
      }
    }
    process.stdout.write(`\r  retagged ok:${ok} fail:${fail}`);
  }
}
console.log(`\nDone. retagged ok:${ok} fail:${fail}`);
