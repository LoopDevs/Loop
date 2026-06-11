// Re-source the media-quality notes the user left (no exact URL given).
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp');
const KEY = process.env.TAVILY_API_KEY;
const PK = process.env.LOGODEV_KEY ?? readFileSync('/tmp/logodev-key.txt', 'utf8').trim();
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const BAD =
  /logos-world|1000logos|seeklogo|pinterest|alamy|dreamstime|shutterstock|istock|getty|placeholder|onetrust|closing/i;
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const idByName = Object.fromEntries(fresh.map((m) => [m.name, m.id]));

const LOGODEV = {
  "Andronico's": 'andronicos.com',
  'Galveston Holiday Inn': 'holidayinn.com',
  'Great American Days': 'greatamericandays.co.uk',
};
const COVER_Q = {
  'Good Night Inns': 'Good Night Inns UK country hotel exterior sunny',
  'Bed Bath & Beyond': 'Bed Bath and Beyond store interior aisle',
  'Great American Days': 'hot air balloon ride experience sky',
  'Fannie May': 'Fannie May chocolate shop store',
  'Farmhouse Inns': 'Farmhouse Inns pub restaurant interior dining',
};
// hard/niche — attempt both logo + cover via search
const HARD = {
  Aera: 'Aera restaurant Toronto Oliver Bonacini',
  'Edna + Vita': 'Edna Vita restaurant Toronto',
  'Fashion Queen': 'Fashion Queen clothing store',
};

async function reach(url, wantImg = true) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    if (wantImg && !/image/i.test(r.headers.get('content-type') || '')) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}
async function ink(b) {
  const { data } = await sharp(b, { failOn: 'none' })
    .resize(128, 128, { fit: 'inside' })
    .flatten({ background: '#fff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let n = 0;
  for (const p of data) if (p < 235) n++;
  return n / data.length;
}
async function tavily(q) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: KEY, query: q, include_images: true, max_results: 10 }),
    });
    if (!r.ok) return [];
    return ((await r.json()).images || [])
      .map((im) => (typeof im === 'string' ? im : im.url))
      .filter((u) => u && !BAD.test(u));
  } catch {
    return [];
  }
}

let log = [];
// logo.dev logos
for (const [name, dom] of Object.entries(LOGODEV)) {
  const id = idByName[name];
  if (!id || !media[id]) continue;
  const url = `https://img.logo.dev/${dom}?token=${PK}&size=512&format=png&fallback=404`;
  const b = await reach(url);
  if (b && (await ink(b)) > 0.02) {
    media[id].logoUrl = url;
    media[id].logoSource = 'logo.dev';
    log.push('logo ✓ ' + name);
  } else log.push('logo ✗ ' + name);
}
// Tavily covers (real photo, landscape)
for (const [name, q] of Object.entries(COVER_Q)) {
  const id = idByName[name];
  if (!id || !media[id]) continue;
  let done = false;
  for (const u of await tavily(q)) {
    const b = await reach(u);
    if (!b) continue;
    try {
      const m = await sharp(b, { failOn: 'none' }).metadata();
      if (m.width >= 800 && m.width / m.height >= 1.3 && m.width / m.height <= 2.6) {
        media[id].headerUrl = u;
        media[id].headerSource = 'tavily-note';
        log.push('cover ✓ ' + name);
        done = true;
        break;
      }
    } catch {}
  }
  if (!done) log.push('cover ✗ ' + name);
}
// hard: logo + cover
for (const [name, q] of Object.entries(HARD)) {
  const id = idByName[name];
  if (!id || !media[id]) continue;
  let lg = false,
    cv = false;
  for (const u of await tavily(q + ' logo')) {
    const b = await reach(u);
    if (b) {
      const k = await ink(b).catch(() => 0);
      const m = await sharp(b, { failOn: 'none' })
        .metadata()
        .catch(() => ({}));
      if (k > 0.03 && k < 0.55 && m.width >= 100 && m.width < 1500 && m.width / m.height < 4) {
        media[id].logoUrl = u;
        media[id].logoSource = 'tavily-logo';
        lg = true;
        break;
      }
    }
  }
  for (const u of await tavily(q)) {
    const b = await reach(u);
    if (b) {
      try {
        const m = await sharp(b, { failOn: 'none' }).metadata();
        if (m.width >= 800 && m.width / m.height >= 1.3 && m.width / m.height <= 2.6) {
          media[id].headerUrl = u;
          media[id].headerSource = 'tavily-note';
          cv = true;
          break;
        }
      } catch {}
    }
  }
  log.push(`hard ${name}: logo ${lg ? '✓' : '✗'} cover ${cv ? '✓' : '✗'}`);
}
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
copyFileSync('/tmp/ctx-media-final.json', '/Users/ash/loop-media-work/ctx-media-final.json');
console.log(log.join('\n'));
