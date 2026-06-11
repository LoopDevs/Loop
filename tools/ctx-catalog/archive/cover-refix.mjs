#!/usr/bin/env node
// Re-fix the covers flagged by the vision-QC. Frugal: ONE disambiguated Tavily
// query each, STRICT verify (real image, landscape, not a tiny placeholder).
//   - Town & City "- <town>" → "<town> <country> town centre high street"
//   - brands                  → "<brand> <first words of description>" (disambiguates Blizzard→game, Bolt→rideshare)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');

const KEY = process.env.TAVILY_API_KEY;
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const BAD =
  /logos-world|1000logos|seeklogo|brandirectory|pinterest|alamy|dreamstime|shutterstock|istock|getty|123rf|depositphotos|flaticon|pngwing|cleanpng|woocommerce|placeholder/i;
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const info = JSON.parse(readFileSync('/tmp/ctx-info.json', 'utf8'));
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const names = Object.fromEntries(fresh.map((m) => [m.id, m.name]));
const country = Object.fromEntries(fresh.map((m) => [m.id, m.country]));
const CC = { US: 'USA', GB: 'UK', CA: 'Canada' };

let flags = [];
for (const f of ['/tmp/tcfin-flags-0.json', '/tmp/tcfin-flags-2.json']) {
  try {
    flags.push(...JSON.parse(readFileSync(f, 'utf8')));
  } catch {}
}
flags = flags.filter((f) => f.id && media[f.id]);

async function verify(url) {
  // real landscape image, not a placeholder
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const b = Buffer.from(await r.arrayBuffer());
    const m = await sharp(b, { failOn: 'none' }).metadata();
    return (
      m.width >= 700 && m.height >= 380 && m.width / m.height >= 1.2 && m.width / m.height <= 2.6
    );
  } catch {
    return false;
  }
}
async function findCover(t) {
  const nm = names[t.id] || '';
  const isTC = /^Town & City Gift Cards - /.test(nm);
  const cc = CC[country[t.id]] || '';
  let q;
  if (isTC) q = `${nm.replace(/^Town & City Gift Cards - /, '')} ${cc} town centre high street`;
  else {
    const hint = (info[t.id]?.description || '').split(/\s+/).slice(2, 9).join(' ');
    q = `${nm.replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '')} ${hint}`.trim();
  }
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: KEY, query: q, include_images: true, max_results: 10 }),
    });
    if (!r.ok) return { capped: r.status === 432 };
    const imgs = ((await r.json()).images || [])
      .map((im) => (typeof im === 'string' ? im : im.url))
      .filter((u) => u && !BAD.test(u));
    for (const u of imgs) {
      if (await verify(u)) return { url: u, isTC };
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
  while (idx < flags.length && !capped) {
    const t = flags[idx++]; // capture BEFORE the await — fixes the race that mis-assigned covers
    const res = await findCover(t);
    if (res.capped) {
      capped = true;
      break;
    }
    if (res.url) {
      media[t.id].headerUrl = res.url;
      media[t.id].headerSource = res.isTC ? 'town-photo' : 'tavily-refix';
      set++;
    } else {
      media[t.id].headerUrl = null;
      media[t.id].headerSource = 'flagged-removed';
      miss++;
    }
  }
}
console.log(`re-fixing ${flags.length} flagged covers (1 query each)…`);
await Promise.all(Array.from({ length: 4 }, worker));
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
console.log(`set:${set} miss(nulled):${miss}${capped ? ' — CAPPED' : ''}`);
