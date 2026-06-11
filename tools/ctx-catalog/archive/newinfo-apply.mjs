#!/usr/bin/env node
// Apply content + source media for the 98 new merchants, using the brand-research
// agents' hints. Logos via logo.dev (free), covers via Tavily (1 query each, frugal),
// all reachability-verified. Merges intro/description/instructions/terms into ctx-info.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');

const KEY = process.env.TAVILY_API_KEY;
const PK = process.env.LOGODEV_KEY ?? readFileSync('/tmp/logodev-key.txt', 'utf8').trim();
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const BAD =
  /logos-world|1000logos|seeklogo|pinterest|alamy|dreamstime|shutterstock|istock|getty|placeholder|woocommerce/i;

let entries = [];
for (let k = 0; k < 7; k++) {
  try {
    entries.push(...JSON.parse(readFileSync(`/tmp/newinfo-out-${k}.json`, 'utf8')));
  } catch {}
}
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const info = JSON.parse(readFileSync('/tmp/ctx-info.json', 'utf8'));
const names = Object.fromEntries(
  JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m.name]),
);

async function logoReachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    return r.ok && /image/i.test(r.headers.get('content-type') || '');
  } catch {
    return false;
  }
}
async function coverGood(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const b = Buffer.from(await r.arrayBuffer());
    const m = await sharp(b, { failOn: 'none' }).metadata();
    return m.width >= 700 && m.width / m.height >= 1.2 && m.width / m.height <= 2.7;
  } catch {
    return false;
  }
}
async function findLogo(domain) {
  if (!domain) return null;
  const root = domain.replace(/^www\./, '');
  for (const d of [root, root.split('.').slice(-2).join('.')]) {
    const url = `https://img.logo.dev/${d}?token=${PK}&size=512&format=png&fallback=404`;
    if (await logoReachable(url)) return url;
  }
  return null;
}
async function findCover(q) {
  if (!q) return null;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: KEY, query: q, include_images: true, max_results: 8 }),
    });
    if (!r.ok) return { capped: r.status === 432 };
    const imgs = ((await r.json()).images || [])
      .map((im) => (typeof im === 'string' ? im : im.url))
      .filter((u) => u && !BAD.test(u));
    for (const u of imgs) {
      if (await coverGood(u)) return { url: u };
    }
  } catch {}
  return {};
}

let idx = 0,
  logos = 0,
  covers = 0,
  capped = false;
async function worker() {
  while (idx < entries.length && !capped) {
    const e = entries[idx++];
    info[e.id] = {
      intro: e.intro || '',
      description: e.description || '',
      instructions: e.instructions || '',
      terms: e.terms || '',
    };
    if (!media[e.id]) media[e.id] = { name: names[e.id] || e.name };
    const logo = await findLogo(e.logoDomain);
    if (logo) {
      media[e.id].logoUrl = logo;
      media[e.id].logoSource = 'logo.dev';
      logos++;
    }
    const cov = await findCover(e.coverQuery);
    if (cov.capped) {
      capped = true;
      break;
    }
    if (cov.url) {
      media[e.id].headerUrl = cov.url;
      media[e.id].headerSource = 'tavily-new';
      covers++;
    }
  }
}
console.log(`applying content + media for ${entries.length} new merchants…`);
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync('/tmp/ctx-info.json', JSON.stringify(info, null, 2));
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
console.log(
  `info applied:${entries.length} | logos:${logos} | covers:${covers}${capped ? ' — KEY CAPPED' : ''}`,
);
