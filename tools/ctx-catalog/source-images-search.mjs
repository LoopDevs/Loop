#!/usr/bin/env node
/**
 * Source merchant cover images via keyless image search (DuckDuckGo /
 * Bing-backed) instead of hitting WAF-protected brand sites. For each
 * merchant it queries the brand name (+ light vertical hint), filters out
 * watermark-stock + logo-aggregator + social domains, and picks the largest
 * landscape image that crops cleanly to 16:9.
 *
 * Output: /tmp/ctx-images-search.json  { id: { name, candidates:[{url,w,h,source}], headerUrl } }
 * Candidates kept so the review UI / a re-pick can swap if the top is bad.
 *
 *   node scripts/source-images-search.mjs [--limit N] [--test]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const TEST = args.includes('--test');
const outPath = '/tmp/ctx-images-search.json';

// Reject watermark stock, logo aggregators, social, and irrelevant hosts.
const BAD =
  /alamy|dreamstime|shutterstock|istockphoto|gettyimages|123rf|depositphotos|stockphoto|stock\.adobe|logos-world|1000logos|brandirectory|seeklogo|logodownload|logowik|logo\.wine|freebiesupply|wikimedia|wikipedia|pinterest|fbcdn|facebook|twimg|ebay|amazon\.com\/images|aliexpress|youtube|ytimg|tiktok|reddit|vecteezy|freepik|pngwing|pngegg|cleanpng|kindpng|flaticon/i;
// Queries that bias toward real brand/lifestyle imagery, not logos.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function vqd(q) {
  const h = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`, {
    headers: { 'User-Agent': UA },
  });
  const html = await h.text();
  const m =
    html.match(/vqd=\"([^\"]+)\"/) || html.match(/vqd=([\d-]+)&/) || html.match(/vqd=([\w-]+)/);
  return m ? m[1] : null;
}
async function imageSearch(q) {
  const token = await vqd(q);
  if (!token) return [];
  const r = await fetch(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${token}&f=,,,,,&p=1`,
    {
      headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/', Accept: 'application/json' },
    },
  );
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return j.results || [];
}

function pick(results) {
  const good = results.filter((x) => {
    if (!x.image || BAD.test(x.image) || BAD.test(x.source || '') || BAD.test(x.url || ''))
      return false;
    const r = x.width / x.height;
    return x.width >= 640 && x.height >= 360 && r >= 1.4 && r <= 2.3;
  });
  // prefer closest to 16:9 with good size
  good.sort((a, b) => {
    const sa = a.width * a.height - Math.abs(a.width / a.height - 16 / 9) * 400000;
    const sb = b.width * b.height - Math.abs(b.width / b.height - 16 / 9) * 400000;
    return sb - sa;
  });
  return good.slice(0, 5);
}

async function main() {
  const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
  let targets = JSON.parse(readFileSync('/tmp/ctx-rescrape-targets.json', 'utf8')).filter(
    (m) => m.needHeader,
  );
  if (TEST) {
    // a cross-vertical hand-picked dozen
    const names = [
      'adidas UK',
      'Argos',
      'Boots',
      'Joe’s Crab Shack',
      'Lululemon',
      'Sephora US',
      'GameStop',
      'Olive Garden',
      'IKEA US',
      'Petco',
      'Foot Locker UK',
      'Sephora',
    ];
    targets = targets.filter((m) => names.some((n) => m.name === n)).slice(0, 12);
    if (!targets.length)
      targets = JSON.parse(readFileSync('/tmp/ctx-rescrape-targets.json', 'utf8'))
        .filter((m) => m.needHeader)
        .slice(0, 12);
  }
  if (LIMIT !== Infinity) targets = targets.slice(0, LIMIT);
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  const todo = targets.filter((m) => !(m.id in out));
  console.log(`Image-search covers: ${targets.length} targets, ${todo.length} to do\n`);
  let done = 0;
  for (const m of todo) {
    const brand = m.name.replace(/\s+(US|USA|UK|GB|Canada|CA|Europe)$/i, '');
    let cands = [];
    for (const q of [`${brand}`, `${brand} store`, `${brand} brand campaign`]) {
      try {
        cands = pick(await imageSearch(q));
      } catch {
        cands = [];
      }
      if (cands.length) break;
      await sleep(400);
    }
    const top = cands[0];
    const headerUrl = top
      ? `https://images.weserv.nl/?url=${encodeURIComponent(top.image)}&w=${Math.min(1280, top.width)}&h=${Math.round((Math.min(1280, top.width) * 9) / 16)}&fit=cover&output=jpg`
      : null;
    out[m.id] = {
      name: m.name,
      headerUrl,
      headerSource: top ? 'image-search' : null,
      candidates: cands.map((c) => ({ url: c.image, w: c.width, h: c.height, source: c.source })),
    };
    done++;
    console.log(
      `${headerUrl ? '✓' : '○'} ${m.name.slice(0, 30).padEnd(30)} ${top ? top.width + 'x' + top.height + '  ' + (top.source || '') : 'no usable result'}`,
    );
    if (done % 20 === 0) writeFileSync(outPath, JSON.stringify(out, null, 2));
    await sleep(500);
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `\nDone. covers found: ${Object.values(out).filter((r) => r.headerUrl).length}/${Object.keys(out).length}. Wrote ${outPath}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
