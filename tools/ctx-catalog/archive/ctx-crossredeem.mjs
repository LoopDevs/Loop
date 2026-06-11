#!/usr/bin/env node
/**
 * Cross-redeemability scanner (read-only, no CTX writes). Parses each
 * merchant's supplier "how to use" / terms / description for redeem
 * locations + brand names, and matches mentions against OTHER catalogue
 * merchants — surfacing cards usable at multiple brands (e.g. a Carter's
 * card redeemable at OshKosh B'gosh / Skip Hop / Little Planet).
 *
 * Output: /tmp/ctx-crossredeem.json  { merchantId: { name, redeemableAt:[{brand,id}], evidence } }
 * for human review BEFORE any link is created.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const enrich = JSON.parse(readFileSync('/tmp/ctx-enrichment.json', 'utf8'));

const LABELS = /\s+(US|USA|UK|GB|Canada|CA|Europe)$/i;
const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(LABELS, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Catalogue brand index: normalized base name → {display, id}. Skip very
// short / generic names that would false-match in prose.
const STOP = new Set([
  'gap',
  'kids',
  'sierra',
  'kings',
  'acme',
  'jump',
  'lena',
  'luma',
  'visa',
  'apple',
  'meta',
  'amazon',
  '76',
]);
const brandIndex = new Map();
for (const m of merchants) {
  const n = norm(m.name);
  if (n.length < 5 || STOP.has(n)) continue;
  if (!brandIndex.has(n)) brandIndex.set(n, { display: m.name.replace(LABELS, ''), id: m.id });
}

// Redemption-context sentence detector (only scan these, to avoid prose false-positives).
const CTX =
  /redeemable|valid at|accepted at|use (?:it|your card|this card) at|owned and operated|company[- ]owned|stores? (?:including|such as|nationwide)|family of (?:brands|stores)|also (?:be )?used at|good at (?:all|any)|any of (?:our|the)/i;

const out = {};
for (const m of merchants) {
  const e = enrich[m.id];
  if (!e) continue;
  const text = `${e.instructions || ''} . ${e.description || ''}`;
  const selfNorm = norm(m.name);
  const hits = new Map();
  let evidence = '';
  for (const sentence of text.split(/[.!\n•]/)) {
    if (!CTX.test(sentence)) continue;
    const sn = ` ${norm(sentence)} `;
    for (const [bn, info] of brandIndex) {
      if (bn === selfNorm) continue;
      if (
        sn.includes(` ${bn} `) ||
        sn.includes(` ${bn},`) ||
        sn.includes(` ${bn} or`) ||
        sn.includes(` ${bn} and`)
      ) {
        if (!hits.has(info.id)) {
          hits.set(info.id, info.display);
          if (!evidence) evidence = sentence.trim().slice(0, 220);
        }
      }
    }
  }
  if (hits.size)
    out[m.id] = {
      name: m.name,
      redeemableAt: [...hits.entries()].map(([id, brand]) => ({ brand, id })),
      evidence,
    };
}
writeFileSync('/tmp/ctx-crossredeem.json', JSON.stringify(out, null, 2));
console.log(
  `Cross-redeemability candidates: ${Object.keys(out).length} merchants reference other catalogue brands in their redeem terms.\n`,
);
const sorted = Object.values(out).sort((a, b) => b.redeemableAt.length - a.redeemableAt.length);
for (const r of sorted.slice(0, 25))
  console.log(`  ${r.name}  →  ${r.redeemableAt.map((x) => x.brand).join(', ')}`);
