#!/usr/bin/env node
/**
 * Final media assembly with real-pixel dimension gates.
 *   logo:   scraped (≥128×128) → Tillo supplier logo (180px) → none   (NO monogram)
 *   header: scraped (≥640×360) → none                                 (fallback decided later)
 *   generics (21): from /tmp/ctx-generic-media.json (Visa/MC logos, category icons, Unsplash covers)
 *
 * Verifies each scraped URL's true dimensions (logo-dims.mjs) — rejects
 * the sub-128 favicons and sub-640×360 headers the scraper let through.
 * Output: /tmp/ctx-media-final.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { imageDimensions } from './logo-dims.mjs';

const media = JSON.parse(readFileSync('/tmp/ctx-media.json', 'utf8'));
const generic = JSON.parse(readFileSync('/tmp/ctx-generic-media.json', 'utf8'));
const merchants = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).filter(
  (m) => m.status === 'enabled',
);
const tillo = Object.fromEntries(
  JSON.parse(readFileSync('/tmp/tillo-full.json', 'utf8')).map((b) => [b.slug, b]),
);

const tilloLogoFor = (m) => {
  for (const d of m.discounts || [])
    if (d.provider === 'tillo' && tillo[d.providerId]?.logoUrl) return tillo[d.providerId].logoUrl;
  return null;
};
const ok = (d, minW, minH) => d && (d.svg || (d.w >= minW && d.h >= minH));

const ids = merchants.map((m) => m.id);
const out = {};
let logoSite = 0,
  logoTillo = 0,
  logoNone = 0,
  hdrSite = 0,
  hdrNone = 0,
  rejLogo = 0,
  rejHdr = 0;

let idx = 0;
async function worker() {
  while (idx < ids.length) {
    const m = merchants[idx++];
    if (generic[m.id]) {
      // pre-built generic (icon/real logo + unsplash cover)
      out[m.id] = {
        name: m.name,
        logoUrl: generic[m.id].logoUrl,
        logoSource: 'generic',
        headerUrl: generic[m.id].headerUrl,
        headerSource: 'generic-unsplash',
      };
      continue;
    }
    const sc = media[m.id] || {};
    // logo: scraped (≥128) → tillo (180) → none
    let logoUrl = null,
      logoSource = 'none';
    if (sc.logoUrl) {
      const d = await imageDimensions(sc.logoUrl);
      if (ok(d, 128, 128)) {
        logoUrl = sc.logoUrl;
        logoSource = 'site';
        logoSite++;
      } else rejLogo++;
    }
    if (!logoUrl) {
      const t = tilloLogoFor(m);
      if (t) {
        logoUrl = t;
        logoSource = 'tillo';
        logoTillo++;
      }
    }
    if (!logoUrl) logoNone++;
    // header: scraped (≥640×360) → none
    let headerUrl = null,
      headerSource = 'none';
    if (sc.headerUrl) {
      const d = await imageDimensions(sc.headerUrl);
      if (ok(d, 640, 360)) {
        headerUrl = sc.headerUrl;
        headerSource = 'site';
        hdrSite++;
      } else rejHdr++;
    }
    if (!headerUrl) hdrNone++;
    out[m.id] = {
      name: m.name,
      domain: sc.domain || null,
      logoUrl,
      logoSource,
      headerUrl,
      headerSource,
    };
  }
}
await Promise.all(Array.from({ length: 12 }, worker));

writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(out, null, 2));
console.log(`Merged media for ${ids.length} merchants:`);
console.log(
  `  LOGO   site:${logoSite} tillo:${logoTillo} generic:${Object.keys(generic).length} none:${logoNone}  (rejected sub-128 scraped: ${rejLogo})`,
);
console.log(
  `  HEADER site:${hdrSite} generic:${Object.keys(generic).length} none:${hdrNone}  (rejected sub-640×360 scraped: ${rejHdr})`,
);
