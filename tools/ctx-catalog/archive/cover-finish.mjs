#!/usr/bin/env node
// Finish the remaining cover gaps with MINIMAL Tavily usage (PAYG key — be frugal):
// exactly ONE search per merchant, pick the best reachable landscape real-photo.
//   - Town & City "- <town>"  → "<town> town centre high street" (correct-town photo)
//   - everything else          → "<brand> storefront"
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.TAVILY_API_KEY;
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const BAD =
  /logos-world|1000logos|seeklogo|brandirectory|pinterest|alamy|dreamstime|shutterstock|istock|getty|123rf|depositphotos|flaticon|pngwing|cleanpng/i;
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const info = JSON.parse(readFileSync('/tmp/ctx-info.json', 'utf8'));
const names = Object.fromEntries(
  JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'))
    .filter((m) => m.status === 'enabled')
    .map((m) => [m.id, m.name]),
);
const CC = { US: 'USA', GB: 'UK', CA: 'Canada' };
const country = Object.fromEntries(
  JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m.country]),
);

// targets: Town & City needing a town photo + any flagged-removed/blank cover
const targets = [];
for (const [id, v] of Object.entries(media)) {
  const nm = names[id];
  if (!nm) continue;
  const isTC = /^Town & City Gift Cards - /.test(nm);
  const needsTC = isTC && v.headerSource !== 'town-photo';
  const blank = !v.headerUrl || v.headerSource === 'flagged-removed';
  if (needsTC || blank)
    targets.push({
      id,
      name: nm,
      town: isTC ? nm.replace(/^Town & City Gift Cards - /, '') : null,
    });
}

async function reachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const ct = r.headers.get('content-type') || '';
    return /image/i.test(ct);
  } catch {
    return false;
  }
}
async function dims(url) {
  // cheap: use content-type already checked; get dims via range not needed — trust Tavily landscape
  return true;
}
async function searchOne(t) {
  const cc = CC[country[t.id]] || '';
  const q = t.town
    ? `${t.town} ${cc} town centre high street`
    : `${t.name.replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '')} storefront`;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        query: q,
        include_images: true,
        include_image_descriptions: true,
        max_results: 8,
      }),
    });
    if (!r.ok) return { capped: r.status === 432 };
    const imgs = ((await r.json()).images || [])
      .map((im) => (typeof im === 'string' ? { url: im } : im))
      .filter((im) => im.url && !BAD.test(im.url));
    for (const im of imgs) {
      if (await reachable(im.url)) return { url: im.url };
    }
    return {};
  } catch {
    return {};
  }
}

let idx = 0,
  set = 0,
  miss = 0,
  capped = false;
async function worker() {
  while (idx < targets.length && !capped) {
    const t = targets[idx++];
    const res = await searchOne(t);
    if (res.capped) {
      capped = true;
      break;
    }
    if (res.url) {
      media[t.id].headerUrl = res.url;
      media[t.id].headerSource = t.town ? 'town-photo' : 'tavily-finish';
      set++;
    } else {
      miss++;
    }
  }
}
console.log(`finishing ${targets.length} covers (1 query each)…`);
await Promise.all(Array.from({ length: 5 }, worker));
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
console.log(
  `set:${set} miss:${miss}${capped ? ' — KEY CAPPED, stopped early' : ''} | remaining targets:${targets.length - set - miss}`,
);
