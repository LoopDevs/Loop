#!/usr/bin/env node
/**
 * Re-tag foreign-region digital SKUs to their real country (ADR-034 location).
 *
 * The EzPin onboarding priced 95-region products (Tinder, PUBG, …) in USD and so
 * filed them all under US. This moves "Tinder 1 Month Platinum ARE" → country AE,
 * etc., from the trailing ISO alpha-3 code in the name, via CTX bulk-update
 * (PUT /merchants {filter:{ids}, country}). Currency stays USD (only country
 * changes). Regions that are Loop markets show there; the rest become
 * catalog-only (not routed); a Tinder-only geo never surfaces (ADR-035 ≥15).
 *
 *   node scripts/ctx-region-retag.mjs           # dry-run plan
 *   node scripts/ctx-region-retag.mjs --apply   # bulk-update (CTX_TOKEN)
 */
import { readFileSync, existsSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const BASE = 'https://spend.ctx.com';
const TOKEN = (
  process.env.CTX_TOKEN ||
  (existsSync('/tmp/ctx-token.txt') ? readFileSync('/tmp/ctx-token.txt', 'utf8') : '')
).trim();
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'x-client-id': 'ctx_admin',
  'Content-Type': 'application/json',
};

// ISO 3166-1 alpha-3 → alpha-2 (full table).
const A3 = {
  ABW: 'AW',
  AFG: 'AF',
  AGO: 'AO',
  AIA: 'AI',
  ALA: 'AX',
  ALB: 'AL',
  AND: 'AD',
  ARE: 'AE',
  ARG: 'AR',
  ARM: 'AM',
  ASM: 'AS',
  ATA: 'AQ',
  ATF: 'TF',
  ATG: 'AG',
  AUS: 'AU',
  AUT: 'AT',
  AZE: 'AZ',
  BDI: 'BI',
  BEL: 'BE',
  BEN: 'BJ',
  BES: 'BQ',
  BFA: 'BF',
  BGD: 'BD',
  BGR: 'BG',
  BHR: 'BH',
  BHS: 'BS',
  BIH: 'BA',
  BLM: 'BL',
  BLR: 'BY',
  BLZ: 'BZ',
  BMU: 'BM',
  BOL: 'BO',
  BRA: 'BR',
  BRB: 'BB',
  BRN: 'BN',
  BTN: 'BT',
  BVT: 'BV',
  BWA: 'BW',
  CAF: 'CF',
  CAN: 'CA',
  CCK: 'CC',
  CHE: 'CH',
  CHL: 'CL',
  CHN: 'CN',
  CIV: 'CI',
  CMR: 'CM',
  COD: 'CD',
  COG: 'CG',
  COK: 'CK',
  COL: 'CO',
  COM: 'KM',
  CPV: 'CV',
  CRI: 'CR',
  CUB: 'CU',
  CUW: 'CW',
  CXR: 'CX',
  CYM: 'KY',
  CYP: 'CY',
  CZE: 'CZ',
  DEU: 'DE',
  DJI: 'DJ',
  DMA: 'DM',
  DNK: 'DK',
  DOM: 'DO',
  DZA: 'DZ',
  ECU: 'EC',
  EGY: 'EG',
  ERI: 'ER',
  ESH: 'EH',
  ESP: 'ES',
  EST: 'EE',
  ETH: 'ET',
  FIN: 'FI',
  FJI: 'FJ',
  FLK: 'FK',
  FRA: 'FR',
  FRO: 'FO',
  FSM: 'FM',
  GAB: 'GA',
  GBR: 'GB',
  GEO: 'GE',
  GGY: 'GG',
  GHA: 'GH',
  GIB: 'GI',
  GIN: 'GN',
  GLP: 'GP',
  GMB: 'GM',
  GNB: 'GW',
  GNQ: 'GQ',
  GRC: 'GR',
  GRD: 'GD',
  GRL: 'GL',
  GTM: 'GT',
  GUF: 'GF',
  GUM: 'GU',
  GUY: 'GY',
  HKG: 'HK',
  HMD: 'HM',
  HND: 'HN',
  HRV: 'HR',
  HTI: 'HT',
  HUN: 'HU',
  IDN: 'ID',
  IMN: 'IM',
  IND: 'IN',
  IOT: 'IO',
  IRL: 'IE',
  IRN: 'IR',
  IRQ: 'IQ',
  ISL: 'IS',
  ISR: 'IL',
  ITA: 'IT',
  JAM: 'JM',
  JEY: 'JE',
  JOR: 'JO',
  JPN: 'JP',
  KAZ: 'KZ',
  KEN: 'KE',
  KGZ: 'KG',
  KHM: 'KH',
  KIR: 'KI',
  KNA: 'KN',
  KOR: 'KR',
  KWT: 'KW',
  LAO: 'LA',
  LBN: 'LB',
  LBR: 'LR',
  LBY: 'LY',
  LCA: 'LC',
  LIE: 'LI',
  LKA: 'LK',
  LSO: 'LS',
  LTU: 'LT',
  LUX: 'LU',
  LVA: 'LV',
  MAC: 'MO',
  MAF: 'MF',
  MAR: 'MA',
  MCO: 'MC',
  MDA: 'MD',
  MDG: 'MG',
  MDV: 'MV',
  MEX: 'MX',
  MHL: 'MH',
  MKD: 'MK',
  MLI: 'ML',
  MLT: 'MT',
  MMR: 'MM',
  MNE: 'ME',
  MNG: 'MN',
  MNP: 'MP',
  MOZ: 'MZ',
  MRT: 'MR',
  MSR: 'MS',
  MTQ: 'MQ',
  MUS: 'MU',
  MWI: 'MW',
  MYS: 'MY',
  MYT: 'YT',
  NAM: 'NA',
  NCL: 'NC',
  NER: 'NE',
  NFK: 'NF',
  NGA: 'NG',
  NIC: 'NI',
  NIU: 'NU',
  NLD: 'NL',
  NOR: 'NO',
  NPL: 'NP',
  NRU: 'NR',
  NZL: 'NZ',
  OMN: 'OM',
  PAK: 'PK',
  PAN: 'PA',
  PCN: 'PN',
  PER: 'PE',
  PHL: 'PH',
  PLW: 'PW',
  PNG: 'PG',
  POL: 'PL',
  PRI: 'PR',
  PRK: 'KP',
  PRT: 'PT',
  PRY: 'PY',
  PSE: 'PS',
  PYF: 'PF',
  QAT: 'QA',
  REU: 'RE',
  ROU: 'RO',
  RUS: 'RU',
  RWA: 'RW',
  SAU: 'SA',
  SDN: 'SD',
  SEN: 'SN',
  SGP: 'SG',
  SGS: 'GS',
  SHN: 'SH',
  SJM: 'SJ',
  SLB: 'SB',
  SLE: 'SL',
  SLV: 'SV',
  SMR: 'SM',
  SOM: 'SO',
  SPM: 'PM',
  SRB: 'RS',
  SSD: 'SS',
  STP: 'ST',
  SUR: 'SR',
  SVK: 'SK',
  SVN: 'SI',
  SWE: 'SE',
  SWZ: 'SZ',
  SXM: 'SX',
  SYC: 'SC',
  SYR: 'SY',
  TCA: 'TC',
  TCD: 'TD',
  TGO: 'TG',
  THA: 'TH',
  TJK: 'TJ',
  TKL: 'TK',
  TKM: 'TM',
  TLS: 'TL',
  TON: 'TO',
  TTO: 'TT',
  TUN: 'TN',
  TUR: 'TR',
  TUV: 'TV',
  TWN: 'TW',
  TZA: 'TZ',
  UGA: 'UG',
  UKR: 'UA',
  URY: 'UY',
  USA: 'US',
  UZB: 'UZ',
  VAT: 'VA',
  VCT: 'VC',
  VEN: 'VE',
  VGB: 'VG',
  VIR: 'VI',
  VNM: 'VN',
  VUT: 'VU',
  WLF: 'WF',
  WSM: 'WS',
  YEM: 'YE',
  ZAF: 'ZA',
  ZMB: 'ZM',
  ZWE: 'ZW',
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
let unmapped = 0;
for (const m of merchants) {
  const code3 = (m.name.match(/\b([A-Z]{3})$/) || [])[1];
  if (!code3) continue;
  const dest = A3[code3];
  if (!dest) {
    unmapped++;
    continue;
  }
  if (dest === m.country) continue;
  (byDest.get(dest) || byDest.set(dest, []).get(dest)).push(m);
}

let total = 0,
  toMarket = 0;
const rows = [...byDest.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`Re-tag plan: ${rows.length} destination countries${APPLY ? '' : ' — DRY RUN'}`);
for (const [dest, list] of rows.slice(0, 14)) {
  console.log(
    `  → ${dest}${MARKETS.has(dest) ? ' (market, will SHOW)' : ' (non-market, hidden)'}: ${list.length}`,
  );
}
for (const [dest, list] of rows) {
  total += list.length;
  if (MARKETS.has(dest)) toMarket += list.length;
}
console.log(
  `Total: ${total} SKUs re-tag (${toMarket} into markets, ${total - toMarket} into hidden geos); ${unmapped} had an unmapped trailing code`,
);

if (!APPLY) {
  console.log('\n(dry-run; re-run with --apply)');
  process.exit(0);
}

let ok = 0,
  fail = 0;
for (const [dest, list] of rows) {
  for (let i = 0; i < list.length; i += 120) {
    const batch = list.slice(i, i + 120);
    const ids = batch.map((m) => m.id).join(',');
    try {
      const r = await fetch(`${BASE}/merchants`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify({ filter: { ids, perPage: '500' }, country: dest }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        ok += j.updated ?? batch.length;
      } else {
        fail += batch.length;
        if (fail <= batch.length * 3)
          console.log(`  ✗ ${dest} → ${r.status} ${JSON.stringify(j).slice(0, 90)}`);
      }
    } catch (e) {
      fail += batch.length;
      console.log(`  ✗ ${dest} err ${String(e.message).slice(0, 40)}`);
    }
    process.stdout.write(`\r  re-tagged ok:${ok} fail:${fail}`);
  }
}
console.log(`\nDone. re-tagged ok:${ok} fail:${fail}`);
