import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');
const KEY = process.env.TAVILY_API_KEY;
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const BAD =
  /logos-world|1000logos|seeklogo|pinterest|alamy|dreamstime|shutterstock|istock|getty|placeholder/i;
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const names = Object.fromEntries(
  JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m.name]),
);
const targets = [
  { match: /South Ayrshire/, q: 'Ayr Scotland seafront town centre' },
  { match: /Sunderland/, q: 'Sunderland England city centre Wearmouth' },
];
async function verify(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const b = Buffer.from(await r.arrayBuffer());
    const m = await sharp(b, { failOn: 'none' }).metadata();
    return m.width >= 600 && m.width / m.height >= 1.2 && m.width / m.height <= 2.8;
  } catch {
    return false;
  }
}
for (const tg of targets) {
  const id = Object.keys(media).find(
    (id) => /^Town & City Gift Cards/.test(names[id] || '') && tg.match.test(names[id] || ''),
  );
  if (!id) {
    console.log('not found:', tg.q);
    continue;
  }
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: KEY, query: tg.q, include_images: true, max_results: 10 }),
  });
  const imgs = ((await r.json()).images || [])
    .map((im) => (typeof im === 'string' ? im : im.url))
    .filter((u) => u && !BAD.test(u));
  let done = false;
  for (const u of imgs) {
    if (await verify(u)) {
      media[id].headerUrl = u;
      media[id].headerSource = 'town-photo';
      console.log(`✓ ${names[id]} → ${u.slice(0, 70)}`);
      done = true;
      break;
    }
  }
  if (!done) console.log(`✗ ${names[id]} — no verifiable photo`);
}
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
copyFileSync('/tmp/ctx-media-final.json', '/Users/ash/loop-media-work/ctx-media-final.json');
