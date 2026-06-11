#!/usr/bin/env node
// Source one clean generic category cover per type (for digital/abstract residue
// merchants that have no real storefront photo), then assign to the residue.
import { readFileSync, writeFileSync } from 'node:fs';
import { imageDimensions } from './logo-dims.mjs';

const KEY = process.env.TAVILY_API_KEY;
const LOGOAGG =
  /logos-world|1000logos|brandirectory|seeklogo|logo-marque|flaticon|pngwing|cleanpng/i;
const Q = {
  gaming: 'video gaming controller setup colorful background',
  giftcard: 'colorful gift cards flat lay',
  streaming: 'watching movie streaming on tv living room',
  travel: 'scenic travel landscape destination',
  wellness: 'spa wellness relaxation stones candles',
  learning: 'online learning laptop study desk',
  other: 'shopping bags gifts lifestyle',
};

async function catCover(q) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      query: q,
      include_images: true,
      max_results: 10,
      search_depth: 'basic',
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  for (const im of j.images || []) {
    const url = typeof im === 'string' ? im : im.url;
    if (!url || LOGOAGG.test(url)) continue;
    const d = await imageDimensions(url).catch(() => null);
    if (d && !d.svg && d.w >= 800 && d.w / d.h >= 1.3 && d.w / d.h <= 2.5) return url;
  }
  return null;
}

const covers = {};
for (const [c, q] of Object.entries(Q)) {
  try {
    covers[c] = await catCover(q);
  } catch {
    covers[c] = null;
  }
  console.log(`${c}: ${covers[c] || 'none'}`);
}
writeFileSync('/tmp/ctx-cat-covers.json', JSON.stringify(covers, null, 2));

const residue = JSON.parse(readFileSync('/tmp/ctx-cover-residue.json', 'utf8'));
const m = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
let n = 0;
for (const r of residue) {
  const c = covers[r.cat] || covers.other;
  if (c && m[r.id]) {
    m[r.id].headerUrl = c;
    m[r.id].headerSource = 'generic-category';
    n++;
  }
}
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(m, null, 2));
console.log(`\nassigned generic category covers to ${n} residue merchants`);
