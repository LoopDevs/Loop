#!/usr/bin/env node
/**
 * Thorough duplicate + naming scanner (codifies the human-review findings).
 * Catches what the shallow dedup missed:
 *   - accent variants:        Aéropostale == Aeropostale  (NFKD fold)
 *   - native country names:   adidas BE == adidas Belgique (full country token map)
 *   - sub-brand containment:  Beer52 == Beer52 Craft Beer Club (word-boundary prefix)
 * Emits dup clusters for an AI merge-verify pass + a naming-inconsistency report.
 *   node scripts/ctx-dup-scan.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const M = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);

// accent-fold + lowercase
const fold = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// country token → ISO2 (codes + English + native + adjective forms)
const CTRY = {
  us: 'US',
  usa: 'US',
  america: 'US',
  unitedstates: 'US',
  gb: 'GB',
  uk: 'GB',
  gbr: 'GB',
  britain: 'GB',
  greatbritain: 'GB',
  england: 'GB',
  unitedkingdom: 'GB',
  de: 'DE',
  deu: 'DE',
  ger: 'DE',
  germany: 'DE',
  deutschland: 'DE',
  fr: 'FR',
  fra: 'FR',
  france: 'FR',
  es: 'ES',
  esp: 'ES',
  spain: 'ES',
  espana: 'ES',
  it: 'IT',
  ita: 'IT',
  italy: 'IT',
  italia: 'IT',
  be: 'BE',
  bel: 'BE',
  belgium: 'BE',
  belgique: 'BE',
  belgie: 'BE',
  nl: 'NL',
  nld: 'NL',
  netherlands: 'NL',
  nederland: 'NL',
  holland: 'NL',
  ie: 'IE',
  irl: 'IE',
  ireland: 'IE',
  eire: 'IE',
  at: 'AT',
  aut: 'AT',
  austria: 'AT',
  osterreich: 'AT',
  pt: 'PT',
  prt: 'PT',
  portugal: 'PT',
  fi: 'FI',
  fin: 'FI',
  finland: 'FI',
  suomi: 'FI',
  gr: 'GR',
  grc: 'GR',
  greece: 'GR',
  hellas: 'GR',
  ca: 'CA',
  can: 'CA',
  canada: 'CA',
  ch: 'CH',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  se: 'SE',
  swe: 'SE',
  sweden: 'SE',
  sverige: 'SE',
  dk: 'DK',
  denmark: 'DK',
  danmark: 'DK',
  no: 'NO',
  norway: 'NO',
  norge: 'NO',
  pl: 'PL',
  poland: 'PL',
  polska: 'PL',
  cz: 'CZ',
  czech: 'CZ',
  czechia: 'CZ',
  lu: 'LU',
  luxembourg: 'LU',
  mx: 'MX',
  mexico: 'MX',
  ae: 'AE',
  uae: 'AE',
  emirates: 'AE',
  sa: 'SA',
  ksa: 'SA',
  saudi: 'SA',
  saudiarabia: 'SA',
  in: 'IN',
  india: 'IN',
  au: 'AU',
  australia: 'AU',
  nz: 'NZ',
  newzealand: 'NZ',
  qa: 'QA',
  qatar: 'QA',
  kw: 'KW',
  kuwait: 'KW',
  bh: 'BH',
  bahrain: 'BH',
  om: 'OM',
  oman: 'OM',
  eg: 'EG',
  egypt: 'EG',
  za: 'ZA',
  tr: 'TR',
  turkey: 'TR',
  hr: 'HR',
  croatia: 'HR',
};
// strip ALL trailing/leading country tokens from a folded, tokenised name → brand key
function brandKey(name) {
  let toks = fold(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (toks.length > 1 && CTRY[toks[toks.length - 1]]) toks.pop();
  return toks.join('');
}
function brandWords(name) {
  let toks = fold(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (toks.length > 1 && CTRY[toks[toks.length - 1]]) toks.pop();
  return toks;
}

// 1) exact brandKey + country clusters
const byKey = new Map();
for (const m of M) {
  const k = brandKey(m.name) + '|' + m.country;
  (byKey.get(k) || byKey.set(k, []).get(k)).push(m);
}
const exact = [...byKey.values()].filter((a) => a.length > 1);

// 2) word-boundary containment within same country (Beer52 ⊂ Beer52 Craft Beer Club)
const contain = [];
const byCountry = new Map();
for (const m of M)
  (byCountry.get(m.country) || byCountry.set(m.country, []).get(m.country)).push(m);
for (const list of byCountry.values()) {
  const arr = list.map((m) => ({ m, w: brandWords(m.name) })).filter((x) => x.w.length);
  for (let i = 0; i < arr.length; i++)
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const a = arr[i],
        b = arr[j];
      if (a.w.length >= b.w.length) continue;
      if (a.w.length < 1 || a.w.join('').length < 4) continue;
      // a is a strict word-prefix of b
      if (a.w.every((w, k) => b.w[k] === w) && brandKey(a.m.name) !== brandKey(b.m.name)) {
        contain.push([a.m, b.m]);
      }
    }
}
// dedupe containment pairs and drop ones already in an exact cluster
const seen = new Set(exact.flat().map((m) => m.id));
const containClean = [];
const cseen = new Set();
for (const [a, b] of contain) {
  const k = [a.id, b.id].sort().join('|');
  if (cseen.has(k)) continue;
  cseen.add(k);
  containClean.push([a, b]);
}

console.log(
  '=== EXACT brand+country dup clusters (accent+native-country folded):',
  exact.length,
  '===',
);
exact
  .slice(0, 18)
  .forEach((a) =>
    console.log('  ' + a.map((m) => m.name).join('  ==  ') + '  [' + a[0].country + ']'),
  );
console.log('\n=== CONTAINMENT dups (sub-brand):', containClean.length, '===');
containClean
  .slice(0, 18)
  .forEach(([a, b]) => console.log('  "' + a.name + '"  ⊂  "' + b.name + '"  [' + a.country + ']'));

const clusters = [
  ...exact.map((a) =>
    a.map((m) => ({
      id: m.id,
      name: m.name,
      country: m.country,
      providers: [...new Set((m.discounts || []).map((d) => d.provider))],
      logo: !!m.logoUrl,
    })),
  ),
  ...containClean.map(([a, b]) =>
    [a, b].map((m) => ({
      id: m.id,
      name: m.name,
      country: m.country,
      providers: [...new Set((m.discounts || []).map((d) => d.provider))],
      logo: !!m.logoUrl,
    })),
  ),
];
writeFileSync('/tmp/dup-clusters-v2.json', JSON.stringify(clusters));
console.log('\ntotal candidate clusters:', clusters.length, '→ /tmp/dup-clusters-v2.json');
