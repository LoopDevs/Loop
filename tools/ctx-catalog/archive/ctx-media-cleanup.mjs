#!/usr/bin/env node
/**
 * Media cleanup sweep:
 *  - pull all vision-flagged bad covers (cover-flags-* + site-cover-flags-*)
 *  - null SVG/GIF covers (we want png/jpg only)
 *  - re-source SVG logos + named-bad logos via logo.dev (verified domain, png)
 */
import { readFileSync, writeFileSync } from 'node:fs';
const PK = process.env.LOGODEV_KEY ?? readFileSync('/tmp/logodev-key.txt', 'utf8').trim();
const L = (d) => `https://img.logo.dev/${d}?token=${PK}&size=256&format=png&fallback=404`;
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const domains = JSON.parse(readFileSync('/tmp/ctx-domains-final.json', 'utf8'));

// 1) gather all flagged-bad cover ids
const badCovers = new Set();
for (const f of ['/tmp/cover-flags-', '/tmp/site-cover-flags-']) {
  for (let k = 0; k < 40; k++) {
    try {
      JSON.parse(readFileSync(`${f}${k}.json`, 'utf8')).forEach((b) => b.id && badCovers.add(b.id));
    } catch {}
  }
}

// named logo domain overrides (user-reported wrong logos)
const NAMED = {
  'Foot Locker': 'footlocker.com',
  'Foot Locker US': 'footlocker.com',
  "Frankie & Benny's": 'frankieandbennys.com',
  'Blizzard Canada': 'blizzard.com',
  Blizzard: 'blizzard.com',
  'Blue Dolphin Magazines': 'bluedolphinmagazines.co.uk',
};

let coversPulled = 0,
  gifSvgCovers = 0;
const svgLogoIds = [],
  namedIds = [];
for (const [id, v] of Object.entries(media)) {
  // covers
  if (v.headerUrl && (badCovers.has(id) || /\.(gif|svg)(\?|$)/i.test(v.headerUrl))) {
    if (/\.(gif|svg)(\?|$)/i.test(v.headerUrl)) gifSvgCovers++;
    if (badCovers.has(id)) coversPulled++;
    v.headerUrl = null;
    v.headerSource = 'flagged-removed';
  }
  // logos: SVG → re-source; named → override
  if (v.logoUrl && /\.svg(\?|$)/i.test(v.logoUrl)) svgLogoIds.push(id);
  if (NAMED[v.name]) namedIds.push(id);
}

async function verify(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    return r.ok;
  } catch {
    return false;
  }
}

let svgFixed = 0,
  svgLeft = 0,
  namedFixed = 0;
async function run() {
  // named overrides
  for (const id of namedIds) {
    const url = L(NAMED[media[id].name]);
    if (await verify(url)) {
      media[id].logoUrl = url;
      media[id].logoSource = 'logo.dev';
      namedFixed++;
    }
  }
  // svg logos → logo.dev(verified domain) png
  let i = 0;
  async function w() {
    while (i < svgLogoIds.length) {
      const id = svgLogoIds[i++];
      const d = domains[id]?.domain;
      if (d) {
        const url = L(d);
        if (await verify(url)) {
          media[id].logoUrl = url;
          media[id].logoSource = 'logo.dev';
          svgFixed++;
          continue;
        }
      }
      svgLeft++; // no domain / logo.dev miss → leave (apply-time sharp will rasterize to png)
    }
  }
  await Promise.all(Array.from({ length: 12 }, w));
  writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
  console.log(`covers pulled (flagged): ${coversPulled} | gif/svg covers nulled: ${gifSvgCovers}`);
  console.log(
    `SVG logos: ${svgLogoIds.length} found → ${svgFixed} re-sourced to logo.dev png, ${svgLeft} left (sharp rasterizes at apply)`,
  );
  console.log(`named bad logos fixed: ${namedFixed} of ${namedIds.length}`);
  const dist = {};
  for (const v of Object.values(media))
    dist[v.headerSource || 'none'] = (dist[v.headerSource || 'none'] || 0) + 1;
  console.log('cover distribution now:', JSON.stringify(dist));
}
run();
