#!/usr/bin/env node
/**
 * Media scraper driven by VERIFIED domains (/tmp/ctx-domains-final.json,
 * web-searched + supplier-authoritative). For each merchant's correct
 * brand site, pulls a real logo (header logo → favicon) and a real
 * header/hero image (og:image → largest ~16:9 on-page image — NOT the
 * supplier gift-card templates). Output: /tmp/ctx-media.json
 *   { id: { name, domain, logoUrl, headerUrl, logoSource, headerSource } }
 *
 *   node scripts/scrape-media.mjs [--limit N] [--concurrency 5] [--out path]
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { bigEnough } from './logo-dims.mjs';

const MIN_LOGO = 128; // reject logos smaller than 128×128 (too low-res)

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const concurrency = Number(args[args.indexOf('--concurrency') + 1] ?? 5);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp/ctx-media.json';

const EXTRACT = () => {
  const abs = (u) => {
    try {
      return new URL(u, location.href).toString();
    } catch {
      return null;
    }
  };
  const meta = (s) => document.querySelector(s)?.getAttribute('content') || null;
  const realSrc = (im) => {
    const c = [
      im.currentSrc,
      im.getAttribute('src'),
      im.getAttribute('data-src'),
      im.getAttribute('data-lazy-src'),
      im.getAttribute('data-original'),
      (im.getAttribute('srcset') || '').split(',').pop()?.trim().split(' ')[0],
    ];
    for (const x of c) {
      if (!x) continue;
      const t = x.trim();
      if (!t || /(^|\/)(null|undefined)(\?|$)/i.test(t) || t.startsWith('data:')) continue;
      return t;
    }
    return null;
  };
  const imgs = [...document.querySelectorAll('img')];
  const JUNK =
    /cookielaw|onetrust|trustarc|cookiebot|cookieyes|termly|consent|usercentrics|osano|evidon|quantcast|gdpr|doubleclick|googletag|google-analytics|gstatic|fbcdn|facebook|twitter|x-icon|instagram|linkedin|youtube|tiktok|pinterest|snapchat|whatsapp|visa|mastercard|maestro|amex|discover|paypal|klarna|afterpay|applepay|googlepay|trustpilot|bazaarvoice|feefo|yotpo|app-?store|google-?play|play\.google|badge|award|sprite/i;
  const host = location.hostname.replace(/^www\./, '');
  // logo
  let logo = null;
  const logoImgs = imgs
    .map((im) => ({ im, rs: realSrc(im) }))
    .filter(({ im, rs }) => {
      if (!rs) return false;
      const hay = `${im.alt} ${im.className} ${im.id} ${rs}`.toLowerCase();
      if (!/logo|brand|wordmark/.test(hay) || JUNK.test(hay)) return false;
      const r = im.getBoundingClientRect();
      return r.width >= 24 && r.height >= 12;
    })
    .map(({ im, rs }) => {
      let sh = 1;
      try {
        sh = new URL(rs, location.href).hostname.includes(host) ? 0 : 1;
      } catch {}
      return { rs, sh, top: im.getBoundingClientRect().top };
    })
    .sort((a, b) => a.sh - b.sh || a.top - b.top);
  if (logoImgs.length) logo = abs(logoImgs[0].rs);
  if (!logo) {
    const ic = [...document.querySelectorAll('link[rel~="apple-touch-icon"],link[rel~="icon"]')]
      .map((l) => ({
        h: l.getAttribute('href'),
        s: parseInt((l.getAttribute('sizes') || '0').split('x')[0], 10) || 0,
      }))
      .filter((i) => i.h && !JUNK.test(i.h))
      .sort((a, b) => b.s - a.s);
    if (ic[0]) logo = abs(ic[0].h);
  }
  // header/hero — largest ~16:9
  const TARGET = 16 / 9;
  let best = null,
    bestScore = -1;
  const consider = (url, w, h) => {
    if (!url || w < 640 || h < 360) return;
    const r = w / h;
    if (r < 1.45 || r > 2.1) return;
    const s = w * h - Math.abs(r - TARGET) * 350000;
    if (s > bestScore) {
      bestScore = s;
      best = abs(url);
    }
  };
  for (const im of imgs) consider(realSrc(im), im.naturalWidth, im.naturalHeight);
  for (const el of document.querySelectorAll(
    '[class*="hero" i],[class*="banner" i],[class*="cover" i],[class*="masthead" i],section,header,div',
  )) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (m) {
      const r = el.getBoundingClientRect();
      consider(m[1], Math.round(r.width), Math.round(r.height));
    }
  }
  const og = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  if (og) consider(og, 1200, 630);
  return { logo, header: best };
};

async function validImage(url) {
  if (!url || /(^|\/)(null|undefined)(\?|$)/i.test(url)) return false;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: new URL(url).origin },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return false;
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return false;
    const l = Number(r.headers.get('content-length') || '0');
    return !(l && l < 500);
  } catch {
    return false;
  }
}
const favicon = (d) => `https://icons.duckduckgo.com/ip3/${d}.ico`;

async function scrapeOne(context, m) {
  const page = await context.newPage();
  let logo = null,
    header = null;
  try {
    await page.goto(`https://${m.domain}`, { waitUntil: 'load', timeout: 20000 });
    await page.evaluate(async () => {
      const mx = Math.min(document.body.scrollHeight, 7200);
      for (let y = 0; y < mx; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(600);
    const ex = await page.evaluate(EXTRACT);
    logo = ex.logo;
    header = ex.header;
  } catch {
    /* site failed */
  } finally {
    await page.close();
  }
  let logoUrl = null,
    logoSource = null;
  // Accept a logo only if it's a real image AND ≥128×128 (SVG passes).
  if ((await validImage(logo)) && (await bigEnough(logo, MIN_LOGO))) {
    logoUrl = logo;
    logoSource = 'site';
  } else if (
    (await validImage(favicon(m.domain))) &&
    (await bigEnough(favicon(m.domain), MIN_LOGO))
  ) {
    logoUrl = favicon(m.domain);
    logoSource = 'favicon';
  }
  // else: no usable logo from the site — merge step fills from Tillo supplier logo / monogram.
  let headerUrl = null,
    headerSource = null;
  if (await validImage(header)) {
    headerUrl = header;
    headerSource = 'site';
  }
  return { name: m.name, domain: m.domain, logoUrl, headerUrl, logoSource, headerSource };
}

const withTimeout = (p, ms) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('per-merchant-timeout')), ms)),
  ]);

async function main() {
  const domains = JSON.parse(readFileSync('/tmp/ctx-domains-final.json', 'utf8'));
  let items = Object.entries(domains).map(([id, v]) => ({ id, name: v.name, domain: v.domain }));
  if (limit !== Infinity) items = items.slice(0, limit);
  // Resume: skip ids already in the output file.
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    /* fresh */
  }
  const todo = items.filter((m) => !(m.id in out));
  console.log(
    `Media scrape: ${items.length} total, ${Object.keys(out).length} already done, ${todo.length} to do @ concurrency ${concurrency}\n`,
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
  });
  let idx = 0,
    done = 0;
  const flush = () => writeFileSync(outPath, JSON.stringify(out, null, 2)); // incremental persistence
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      let r;
      try {
        r = await withTimeout(scrapeOne(context, m), 55000);
      } catch {
        r = {
          name: m.name,
          domain: m.domain,
          logoUrl: null,
          headerUrl: null,
          logoSource: null,
          headerSource: null,
          timedOut: true,
        };
      }
      out[m.id] = r;
      done++;
      console.log(
        `${r.logoUrl || r.headerUrl ? '✓' : '○'} ${m.name.slice(0, 30).padEnd(30)} ${m.domain.padEnd(26)} logo:${r.logoSource || '-'} header:${r.headerSource || '-'}${r.timedOut ? ' [timeout]' : ''}`,
      );
      if (done % 25 === 0) flush(); // write every 25 so a hang never loses progress
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await browser.close();
  flush();
  const L = Object.values(out).filter((r) => r.logoUrl).length,
    H = Object.values(out).filter((r) => r.headerUrl).length;
  console.log(`\nDone. ${Object.keys(out).length} sites — logo:${L} header:${H}. Wrote ${outPath}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
