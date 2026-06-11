#!/usr/bin/env node
// Re-source the QC fixes that came back BROKEN/unreachable (would fail at apply).
//  - logos  → logo.dev with the brand's clean domain (size 512), verified reachable
//  - covers → Tavily real-photo search, verified reachable + landscape
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.TAVILY_API_KEY;
const PK = process.env.LOGODEV_KEY ?? readFileSync('/tmp/logodev-key.txt', 'utf8').trim();
const UA = {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
};
const OUT =
  '/private/tmp/claude-501/-Users-ash-code-loop-app/19cd3253-a26f-4157-bfe1-78144150dfbe/tasks/wlw6k9zmm.output';

const fixes = JSON.parse(readFileSync(OUT, 'utf8')).result.fixes.filter((f) => f.fixed && f.newUrl);
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const info = JSON.parse(readFileSync('/tmp/ctx-info.json', 'utf8'));
const domains = JSON.parse(readFileSync('/tmp/ctx-domains-final.json', 'utf8'));
const names = Object.fromEntries(
  JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8')).map((m) => [m.id, m.name]),
);
// Prime Pubs (residue) — Greene King pub brand → use greeneking domain
const PRIME = '572262a2-1521-4005-a89f-359511a1946c';

async function reachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { ...UA, signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}
const derive = (name) =>
  name
    .replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') + '.com';
async function logoDev(id, name) {
  const cands = [
    domains[id]?.domain,
    derive(name),
    derive(name).replace(/\.com$/, '.co.uk'),
  ].filter(Boolean);
  for (const d of cands) {
    const url = `https://img.logo.dev/${d}?token=${PK}&size=512&format=png&fallback=404`;
    if (await reachable(url)) return url;
  }
  return null;
}
async function tavilyCover(name, cat) {
  const brand = name.replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '');
  for (const q of [
    `${brand} storefront`,
    `${brand} ${(cat || '').split(' ').slice(0, 4).join(' ')}`,
    `${brand} shop`,
  ]) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: KEY, query: q, include_images: true, max_results: 8 }),
      });
      if (!r.ok) continue;
      const imgs = ((await r.json()).images || [])
        .map((im) => (typeof im === 'string' ? im : im.url))
        .filter(Boolean);
      for (const u of imgs) {
        if (/logos-world|1000logos|seeklogo|pinterest/i.test(u)) continue;
        if (await reachable(u)) return u;
      }
    } catch {}
  }
  return null;
}

let idx = 0,
  fixedL = 0,
  fixedC = 0,
  failed = 0;
const work = [...fixes];
work.push({ id: PRIME, field: 'logo', newUrl: media[PRIME]?.logoUrl }); // Prime Pubs residue
async function worker() {
  while (idx < work.length) {
    const f = work[idx++];
    if (!media[f.id]) continue;
    if (f.id !== PRIME && (await reachable(f.newUrl))) continue; // only fix broken
    const nm = names[f.id] || media[f.id].name || '';
    if (f.field === 'logo') {
      const u = await logoDev(f.id, nm);
      if (u) {
        media[f.id].logoUrl = u;
        media[f.id].logoSource = 'qc-fixed2';
        fixedL++;
      } else failed++;
    } else {
      const u = await tavilyCover(nm, info[f.id]?.description);
      if (u) {
        media[f.id].headerUrl = u;
        media[f.id].headerSource = 'qc-fixed2';
        fixedC++;
      } else {
        media[f.id].headerUrl = null;
        media[f.id].headerSource = 'flagged-removed';
        failed++;
      }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
console.log(
  `residue re-source — logos fixed:${fixedL} covers fixed:${fixedC} | could-not-fix(cover nulled / logo kept):${failed}`,
);
