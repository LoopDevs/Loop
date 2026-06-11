#!/usr/bin/env node
/**
 * Round-3 cover sourcing for the hard residue, with DISAMBIGUATED queries:
 *  - Town & City "- <town>"  → a photo of the town ("<town> town centre high street")
 *  - everything else         → "<brand> <country> : <first words of its description>"
 *    so ambiguous names resolve correctly (Blizzard the game studio, Wickes UK DIY, etc.)
 *
 * Reads /tmp/ctx-covers3-targets.json [{id,name,country,town,descHint}]
 * Writes /tmp/ctx-covers3.json { id:{name, headerUrl, candidates:[...]} }
 * Needs TAVILY_API_KEY. Concurrent, resumable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { imageDimensions } from './logo-dims.mjs';

const KEY = process.env.TAVILY_API_KEY;
const outPath = '/tmp/ctx-covers3.json';
const CONC = Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? 10);
const BAD =
  /alamy|dreamstime|shutterstock|istockphoto|gettyimages|getty_images|123rf|depositphotos|stock\.adobe|logos-world|1000logos|brandirectory|seeklogo|logo-marque|wikimedia|pinterest|fbcdn|twimg|ytimg|vecteezy|freepik|pngwing|cleanpng|flaticon|seekingalpha/i;
const CC = { US: 'USA', GB: 'UK', CA: 'Canada' };

async function tavily(query) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: KEY,
      query,
      include_images: true,
      include_image_descriptions: true,
      max_results: 6,
      search_depth: 'basic',
    }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const j = await r.json();
  return (j.images || []).filter((im) => im.url && !BAD.test(im.url));
}

async function bestFor(m) {
  const country = CC[m.country] || '';
  let queries;
  if (m.town) {
    queries = [`${m.town} ${country} town centre high street shops`, `${m.town} ${country} town`];
  } else {
    const hint = (m.descHint || '').split(/\s+/).slice(0, 10).join(' ');
    queries = [
      `${m.name.replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '')} ${country} ${hint}`.trim(),
      `${m.name.replace(/\s+(US|USA|UK|GB|Canada|CA)$/i, '')} ${country} store`,
    ];
  }
  const seen = new Set();
  let pool = [];
  for (const q of queries) {
    let imgs = [];
    try {
      imgs = await tavily(q);
    } catch {}
    for (const im of imgs) {
      if (!seen.has(im.url)) {
        seen.add(im.url);
        pool.push(im);
      }
    }
    if (pool.length >= 6) break;
  }
  const ok = [];
  for (const im of pool) {
    const d = await imageDimensions(im.url);
    if (!d || d.svg) continue;
    const r = d.w / d.h;
    if (d.w >= 640 && d.h >= 360 && r >= 1.3 && r <= 2.6) ok.push({ ...im, w: d.w, h: d.h });
    if (ok.length >= 5) break;
  }
  ok.sort(
    (a, b) =>
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
  const targets = JSON.parse(readFileSync('/tmp/ctx-covers3-targets.json', 'utf8'));
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  const todo = targets.filter((m) => !(m.id in out));
  console.log(`Round-3 covers: ${targets.length} targets, ${todo.length} to do @ ${CONC}\n`);
  let done = 0,
    idx = 0;
  const flush = () => writeFileSync(outPath, JSON.stringify(out, null, 2));
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      let cands = [];
      try {
        cands = await bestFor(m);
      } catch {}
      const top = cands[0];
      out[m.id] = {
        name: m.name,
        headerUrl: top ? top.url : null,
        candidates: cands.map((c) => ({
          url: c.url,
          w: c.w,
          h: c.h,
          desc: (c.description || '').slice(0, 80),
        })),
      };
      done++;
      console.log(
        `${top ? '✓' : '○'} ${m.name.slice(0, 32).padEnd(32)} ${top ? top.w + 'x' + top.h : 'none'}`,
      );
      if (done % 15 === 0) flush();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  flush();
  console.log(
    `\nDone. covers:${Object.values(out).filter((r) => r.headerUrl).length}/${Object.keys(out).length}. Wrote ${outPath}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
