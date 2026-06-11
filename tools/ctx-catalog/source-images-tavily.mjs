#!/usr/bin/env node
/**
 * Source merchant cover images via Tavily search (TAVILY_API_KEY) — it
 * returns relevant images WITH descriptions sourced from quality pages,
 * and often the brand's OWN asset CDN. Far cleaner than raw image-rank.
 *
 * For each target it queries the brand (a few phrasings), then:
 *   - drops watermark-stock + logo-aggregator + social domains
 *   - drops images whose description is logo-only (we want a scene/hero)
 *   - PREFERS images hosted on the brand's own domain
 *   - verifies real pixel dims (≥640×360, landscape) and crops 16:9
 *
 * Output: /tmp/ctx-images-tavily.json { id:{name,headerUrl,headerSource,candidates:[...]} }
 *   node scripts/source-images-tavily.mjs [--limit N] [--test]   (needs TAVILY_API_KEY)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { imageDimensions } from './logo-dims.mjs';

const KEY = process.env.TAVILY_API_KEY;
const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const TEST = args.includes('--test');
const outPath = '/tmp/ctx-images-tavily.json';

const BAD =
  /alamy|dreamstime|shutterstock|istockphoto|gettyimages|getty_images|media\.gettyimages|123rf|depositphotos|stock\.adobe|stockphoto|logos-world|1000logos|brandirectory|seeklogo|logo-marque|logodownload|logowik|logo\.wine|freebiesupply|wikimedia|wikipedia|pinterest|fbcdn|twimg|aliexpress|ytimg|tiktok|vecteezy|freepik|pngwing|pngegg|cleanpng|kindpng|flaticon|seekingalpha/i;
const LOGO_ONLY =
  /^(the )?(image (shows|features|depicts) )?(a |the )?(prominent |large |white |red |blue |illuminated )*(logo|sign|signage|wordmark|brand name)\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rootOf = (d) =>
  (d || '')
    .replace(/^www\./, '')
    .split('.')
    .slice(-2)
    .join('.');

async function tavily(query) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      query,
      include_images: true,
      include_image_descriptions: true,
      max_results: 5,
      search_depth: 'basic',
    }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const j = await r.json();
  return (j.images || [])
    .map((im) => (typeof im === 'string' ? { url: im, description: '' } : im))
    .filter((im) => im.url);
}

async function bestFor(m) {
  const brand = m.name.replace(/\s+(US|USA|UK|GB|Canada|CA|Europe)$/i, '');
  const root = rootOf(m.domain);
  const seen = new Set();
  let pool = [];
  for (const q of [`${brand} storefront`, `${brand} store interior`, `${brand} brand lifestyle`]) {
    let imgs = [];
    try {
      imgs = await tavily(q);
    } catch {
      imgs = [];
    }
    for (const im of imgs) {
      if (seen.has(im.url) || BAD.test(im.url) || LOGO_ONLY.test(im.description || '')) continue;
      seen.add(im.url);
      pool.push(im);
    }
    if (pool.length >= 6) break;
    await sleep(250);
  }
  // verify dims; keep landscape ≥640×360
  const ok = [];
  for (const im of pool) {
    const d = await imageDimensions(im.url);
    if (!d || d.svg) continue;
    const r = d.w / d.h;
    if (d.w >= 640 && d.h >= 360 && r >= 1.3 && r <= 2.5)
      ok.push({ ...im, w: d.w, h: d.h, brandOwned: root && im.url.includes(root) });
    if (ok.length >= 5) break;
  }
  // prefer brand-owned domain, then closeness to 16:9 × size
  ok.sort(
    (a, b) =>
      Number(b.brandOwned) - Number(a.brandOwned) ||
      b.w * b.h -
        Math.abs(b.w / b.h - 16 / 9) * 400000 -
        (a.w * a.h - Math.abs(a.w / a.h - 16 / 9) * 400000),
  );
  return ok;
}

async function main() {
  if (!KEY) {
    console.error('TAVILY_API_KEY not set');
    process.exit(2);
  }
  let targets = JSON.parse(readFileSync('/tmp/ctx-rescrape-targets.json', 'utf8')).filter(
    (m) => m.needHeader,
  );
  if (TEST) targets = targets.slice(0, 14);
  if (LIMIT !== Infinity) targets = targets.slice(0, LIMIT);
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  const todo = targets.filter((m) => !(m.id in out));
  const CONC = Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? 8);
  console.log(
    `Tavily covers: ${targets.length} targets, ${todo.length} to do @ concurrency ${CONC}\n`,
  );
  let done = 0,
    idx = 0;
  const flush = () => writeFileSync(outPath, JSON.stringify(out, null, 2));
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      let cands = [];
      try {
        cands = await bestFor(m);
      } catch {
        cands = [];
      }
      const top = cands[0];
      const headerUrl = top
        ? `https://images.weserv.nl/?url=${encodeURIComponent(top.url)}&w=${Math.min(1280, top.w)}&h=${Math.round((Math.min(1280, top.w) * 9) / 16)}&fit=cover&output=jpg`
        : null;
      out[m.id] = {
        name: m.name,
        headerUrl,
        headerSource: top ? (top.brandOwned ? 'tavily-brand' : 'tavily') : null,
        candidates: cands.map((c) => ({
          url: c.url,
          w: c.w,
          h: c.h,
          brandOwned: !!c.brandOwned,
          desc: (c.description || '').slice(0, 80),
        })),
      };
      done++;
      console.log(
        `${headerUrl ? (top.brandOwned ? '★' : '✓') : '○'} ${m.name.slice(0, 28).padEnd(28)} ${top ? top.w + 'x' + top.h + (top.brandOwned ? ' [brand-owned]' : '') : 'none'}`,
      );
      if (done % 15 === 0) flush();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  flush();
  console.log(
    `\nDone. covers:${Object.values(out).filter((r) => r.headerUrl).length}/${Object.keys(out).length} (brand-owned:${Object.values(out).filter((r) => r.headerSource === 'tavily-brand').length}). Wrote ${outPath}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
