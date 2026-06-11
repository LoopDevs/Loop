#!/usr/bin/env node
/**
 * Builds merchant enrichment from authoritative supplier data. For each
 * merchant, follows its discounts → supplier products and gathers the
 * best logo, card image, description, and redemption instructions.
 * Output: /tmp/ctx-enrichment.json
 *   { merchantId: { name, logoUrl, cardImageUrl, description, instructions, sources } }
 *
 * Source preference: Tillo (has real logos + clean copy) → SVS → Ezpin.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const svs = JSON.parse(readFileSync('/tmp/svs-products.json', 'utf8')).result || [];
const tillo = JSON.parse(readFileSync('/tmp/tillo-full.json', 'utf8'));
const ezpin = JSON.parse(readFileSync('/tmp/ezpin-full.json', 'utf8'));

const svsById = Object.fromEntries(svs.map((p) => [p.Id, p]));
const tilloBySlug = Object.fromEntries(tillo.map((b) => [b.slug, b]));
const ezpinById = Object.fromEntries(ezpin.map((p) => [p.id, p]));

// HTML → clean plain text (strip tags, decode common entities, tidy ws).
function clean(html) {
  if (!html) return null;
  let t = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#10;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
  return t || null;
}
function ezpinDesc(p, section) {
  try {
    const d = JSON.parse(p.description);
    const c = (d.content || []).find((x) => new RegExp(section, 'i').test(x.title || ''));
    return c ? clean(c.description) : null;
  } catch {
    return section === 'description' ? clean(p.description) : null;
  }
}

const out = {};
let logoN = 0,
  coverN = 0,
  descN = 0,
  instrN = 0;
for (const m of merchants) {
  if (m.status !== 'enabled') continue;
  const sources = [];
  let logo = null,
    cover = null,
    desc = null,
    instr = null;
  // collect candidate products from the merchant's discounts
  const tilloP = [],
    svsP = [],
    ezpinP = [];
  for (const d of m.discounts || []) {
    if (d.provider === 'tillo' && tilloBySlug[d.providerId]) tilloP.push(tilloBySlug[d.providerId]);
    if (d.provider === 'svs' && svsById[d.providerId]) svsP.push(svsById[d.providerId]);
    if (d.provider === 'ezpin' && ezpinById[d.providerId]) ezpinP.push(ezpinById[d.providerId]);
  }
  // Logo — only Tillo carries a dedicated logo
  if (tilloP[0]?.logoUrl) {
    logo = tilloP[0].logoUrl;
    sources.push('logo:tillo');
  }
  // Card image — Tillo → SVS faceplate → Ezpin image
  if (tilloP[0]?.cardImageUrl) {
    cover = tilloP[0].cardImageUrl;
    sources.push('cover:tillo');
  } else if (svsP.find((p) => p.Media?.Faceplates?.[0]?.Path)) {
    cover = svsP.find((p) => p.Media?.Faceplates?.[0]?.Path).Media.Faceplates[0].Path;
    sources.push('cover:svs');
  } else if (ezpinP.find((p) => p.image)) {
    cover = ezpinP.find((p) => p.image).image;
    sources.push('cover:ezpin');
  }
  // Description — Tillo → SVS Long/Short → Ezpin
  desc =
    clean(tilloP[0]?.description) ||
    clean(svsP.find((p) => p.LongDescription)?.LongDescription) ||
    clean(svsP.find((p) => p.ShortDescription)?.ShortDescription) ||
    ezpinDesc(ezpinP.find((p) => p.description) || {}, 'description');
  if (desc) sources.push('desc');
  // Instructions — SVS RedemptionNote/Terms → Tillo terms → Ezpin redeem
  instr =
    clean(svsP.find((p) => p.RedemptionNote)?.RedemptionNote) ||
    clean(svsP.find((p) => p.Terms)?.Terms) ||
    clean(tilloP[0]?.terms) ||
    ezpinDesc(ezpinP.find((p) => p.description) || {}, 'redeem|redemption|how to use');
  if (instr) sources.push('instr');

  if (logo || cover || desc || instr) {
    out[m.id] = {
      name: m.name,
      logoUrl: logo,
      cardImageUrl: cover,
      description: desc ? desc.slice(0, 1200) : null,
      instructions: instr ? instr.slice(0, 1500) : null,
      sources,
    };
    if (logo) logoN++;
    if (cover) coverN++;
    if (desc) descN++;
    if (instr) instrN++;
  }
}
writeFileSync('/tmp/ctx-enrichment.json', JSON.stringify(out, null, 2));
const live = merchants.filter((m) => m.status === 'enabled').length;
console.log(`Enrichment from supplier data (of ${live} live merchants):`);
console.log(
  `  logo: ${logoN} | cardImage: ${coverN} | description: ${descN} | instructions: ${instrN}`,
);
