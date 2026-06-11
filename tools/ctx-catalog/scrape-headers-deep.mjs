#!/usr/bin/env node
/**
 * Deeper header/hero re-scrape for merchants the first pass left without
 * a ≥640×360 cover. Collects ALL large-image candidates from the brand
 * site (og/twitter meta, <img> + largest srcset, <picture><source>, CSS
 * background-images, link image_src), then verifies REAL dimensions in
 * Node and picks the largest within a 16:9-ish band that clears 640×360.
 *
 * Reads /tmp/ctx-noheader.json → writes /tmp/ctx-headers-deep.json.
 * Per-merchant timeout, incremental writes, resumable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { imageDimensions } from './logo-dims.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const outPath = '/tmp/ctx-headers-deep.json';
const concurrency = Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? 6);

const COLLECT = () => {
  const abs = (u) => {
    try {
      return new URL(u, location.href).toString();
    } catch {
      return null;
    }
  };
  const meta = (s) => document.querySelector(s)?.getAttribute('content') || null;
  const set = new Map(); // url -> sizeHint
  const add = (u, hint) => {
    const a = abs(u);
    if (a && /^https/i.test(a) && !/\.svg(\?|$)/i.test(a))
      set.set(a, Math.max(set.get(a) || 0, hint || 0));
  };
  const fromSrcset = (ss) =>
    (ss || '')
      .split(',')
      .map((s) => s.trim().split(' '))
      .sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0]?.[0];
  for (const s of [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'link[rel="image_src"]',
  ]) {
    const v = s.startsWith('link') ? document.querySelector(s)?.getAttribute('href') : meta(s);
    if (v) add(v, 5000);
  }
  for (const im of document.querySelectorAll('img')) {
    const ss = fromSrcset(im.getAttribute('srcset'));
    if (ss) add(ss, (im.naturalWidth || 0) + 1000);
    const src = im.currentSrc || im.getAttribute('src') || im.getAttribute('data-src');
    if (src && !/(^|\/)(null|undefined)(\?|$)/i.test(src) && !src.startsWith('data:'))
      add(src, im.naturalWidth || 0);
  }
  for (const so of document.querySelectorAll('picture source')) {
    const ss = fromSrcset(so.getAttribute('srcset'));
    if (ss) add(ss, 2000);
  }
  for (const el of document.querySelectorAll(
    '[class*="hero" i],[class*="banner" i],[class*="cover" i],[class*="masthead" i],[class*="slide" i],[class*="carousel" i],header,section,div',
  )) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (m) {
      const r = el.getBoundingClientRect();
      if (r.width >= 400) add(m[1], Math.round(r.width));
    }
  }
  return [...set.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([u]) => u);
};

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const TARGET = 16 / 9;

async function scrapeOne(context, m) {
  const page = await context.newPage();
  let candidates = [];
  try {
    await page.goto(`https://${m.domain}`, { waitUntil: 'load', timeout: 20000 });
    await page.evaluate(async () => {
      const mx = Math.min(document.body.scrollHeight, 8000);
      for (let y = 0; y < mx; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(600);
    candidates = await page.evaluate(COLLECT);
  } catch {
    /* */
  } finally {
    await page.close();
  }
  // Accept any image croppable to ≥640×360 16:9 (any aspect — we trim).
  // Pick the one yielding the biggest 16:9 crop, lightly preferring less
  // cropping (closer-to-16:9 keeps more of the original).
  let best = null,
    bestScore = -1;
  for (const url of candidates) {
    const d = await imageDimensions(url);
    if (!d || d.svg) continue;
    if (d.w < 640 || d.h < 360) continue; // must yield ≥640×360 crop
    const cw = Math.min(d.w, (d.h * 16) / 9);
    const cropArea = (cw * (cw * 9)) / 16;
    const score = cropArea * (0.5 + 0.5 * (cropArea / (d.w * d.h))); // bonus for less crop
    if (score > bestScore) {
      bestScore = score;
      best = { url, w: d.w, h: d.h, cw };
    }
  }
  if (!best) return { name: m.name, headerUrl: null };
  // Crop to 16:9 via weserv, capped at source size (no upscaling), max 1280×720.
  const tw = Math.min(1280, Math.floor(best.cw));
  const th = Math.round((tw * 9) / 16);
  const cropped = `https://images.weserv.nl/?url=${encodeURIComponent(best.url)}&w=${tw}&h=${th}&fit=cover&output=jpg`;
  return {
    name: m.name,
    headerUrl: cropped,
    source: best.url,
    srcDims: `${best.w}x${best.h}`,
    cropDims: `${tw}x${th}`,
  };
}

async function main() {
  const items = JSON.parse(readFileSync('/tmp/ctx-noheader.json', 'utf8'));
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  const todo = items.filter((m) => !(m.id in out));
  console.log(
    `Deeper header scrape: ${items.length} total, ${Object.keys(out).length} done, ${todo.length} to do @ ${concurrency}\n`,
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
  });
  let idx = 0,
    done = 0;
  const flush = () => writeFileSync(outPath, JSON.stringify(out, null, 2));
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      let r;
      try {
        r = await withTimeout(scrapeOne(context, m), 55000);
      } catch {
        r = { name: m.name, headerUrl: null };
      }
      out[m.id] = r;
      done++;
      console.log(
        `${r.headerUrl ? '✓' : '○'} ${m.name.slice(0, 30).padEnd(30)} ${m.domain.padEnd(24)} ${r.headerUrl ? r.w + 'x' + r.h : '-'}`,
      );
      if (done % 25 === 0) flush();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await browser.close();
  flush();
  console.log(
    `\nDone. recovered headers: ${Object.values(out).filter((r) => r.headerUrl).length}/${Object.keys(out).length}. Wrote ${outPath}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
