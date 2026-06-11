// Re-source visible logos for the white/faint ones (invisible on white bg) + Aeropostale's
// wrong-brand logo. Tavily "<brand> logo", pick a candidate with real ink coverage
// (visible, colored) and a logo-like profile (not a photo), verified.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');
const KEY = process.env.TAVILY_API_KEY;
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const BAD =
  /pinterest|alamy|dreamstime|shutterstock|istock|getty|facebook|fbcdn|twimg|placeholder/i;

const flags = JSON.parse(readFileSync('/tmp/logo-opacity-flags.json', 'utf8'));
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const names = Object.fromEntries(fresh.map((m) => [m.id, m.name]));
const targets = [...flags.blank, ...flags.faint].map((f) => ({ id: f.id, name: f.name }));
// add Aeropostale (wrong-brand OneTrust logo)
const aero = fresh.find((m) => /^a[ée]ropostale/i.test(m.name));
if (aero) targets.push({ id: aero.id, name: aero.name });

async function inkOf(buf) {
  const { data } = await sharp(buf, { failOn: 'none' })
    .resize(128, 128, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let n = 0;
  for (const p of data) if (p < 235) n++;
  return n / data.length;
}
async function visibleLogo(name) {
  const q = `${name.replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '')} logo`;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: KEY, query: q, include_images: true, max_results: 12 }),
    });
    if (!r.ok) return { capped: r.status === 432 };
    const imgs = ((await r.json()).images || [])
      .map((im) => (typeof im === 'string' ? im : im.url))
      .filter((u) => u && !BAD.test(u) && /\.(png|jpg|jpeg|webp)/i.test(u));
    for (const u of imgs) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 10000);
        const rr = await fetch(u, { ...UA, signal: c.signal });
        clearTimeout(t);
        if (!rr.ok) continue;
        const b = Buffer.from(await rr.arrayBuffer());
        const meta = await sharp(b, { failOn: 'none' }).metadata();
        if (meta.width < 100 || meta.width > 2000) continue;
        const ratio = meta.width / meta.height;
        if (ratio < 0.3 || ratio > 5) continue;
        const ink = await inkOf(b);
        if (ink >= 0.03 && ink <= 0.55) return { url: u, ink: +ink.toFixed(3) }; // visible logo, not a dense photo
      } catch {}
    }
  } catch {}
  return {};
}

let set = 0,
  miss = [],
  capped = false;
for (const tg of targets) {
  if (capped) break;
  const res = await visibleLogo(tg.name);
  if (res.capped) {
    capped = true;
    break;
  }
  if (res.url && media[tg.id]) {
    media[tg.id].logoUrl = res.url;
    media[tg.id].logoSource = 'logo-visible';
    set++;
    console.log(`✓ ${tg.name} → ink ${res.ink}`);
  } else {
    miss.push(tg.name);
    console.log(`○ ${tg.name} — no visible logo found`);
  }
}
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
copyFileSync('/tmp/ctx-media-final.json', '/Users/ash/loop-media-work/ctx-media-final.json');
console.log(
  `\nfixed:${set} | still-white/miss:${miss.length} (${miss.join(', ')})${capped ? ' — CAPPED' : ''}`,
);
