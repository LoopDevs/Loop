#!/usr/bin/env node
/**
 * Proxied re-scrape for the merchants whose real cover art is gated behind
 * WAF bot-protection (Argos/adidas/etc. 403 datacenter/headless IPs). Routes
 * Playwright through the residential proxy from env (same vars as ~/code/vcc
 * scraper): PROXY_SERVER + PROXY_USERNAME + PROXY_PASSWORD ({session} token
 * supported). For each target it pulls a real hero/og cover (≥640×360, cropped
 * to 16:9 via weserv) and, if missing, a real logo (≥128).
 *
 * Reads /tmp/ctx-rescrape-targets.json → writes /tmp/ctx-media-proxied.json.
 * Per-merchant timeout, incremental flush every 20, resumable.
 *
 *   PROXY_SERVER=… PROXY_USERNAME=… PROXY_PASSWORD=… \
 *     node scripts/scrape-media-proxied.mjs [--concurrency 4]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { imageDimensions, bigEnough } from './logo-dims.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const outPath = '/tmp/ctx-media-proxied.json';
const concurrency = Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? 4);

function proxyForSession(sessionId) {
  const server = process.env.PROXY_SERVER;
  if (!server) return null;
  const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(server);
  const u = new URL(hasScheme ? server : `http://${server}`);
  const scheme = u.protocol.replace(/:$/, '');
  let login = process.env.PROXY_USERNAME || decodeURIComponent(u.username) || '';
  const pass = process.env.PROXY_PASSWORD || decodeURIComponent(u.password) || '';
  if (login.includes('{session}') && sessionId) login = login.replace('{session}', sessionId);
  return {
    server: `${scheme}://${u.hostname}:${u.port || 80}`,
    ...(login ? { username: login, password: pass } : {}),
  };
}

const COLLECT = () => {
  const abs = (u) => {
    try {
      return new URL(u, location.href).toString();
    } catch {
      return null;
    }
  };
  const meta = (s) => document.querySelector(s)?.getAttribute('content') || null;
  const set = new Map();
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
    if (v) add(v, 6000);
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
  // logo candidates (only if needed)
  const JUNK =
    /cookie|consent|gdpr|doubleclick|googletag|facebook|twitter|instagram|linkedin|youtube|tiktok|visa|mastercard|amex|paypal|klarna|trustpilot|badge|sprite/i;
  const host = location.hostname.replace(/^www\./, '');
  let logo = null;
  const li = [...document.querySelectorAll('img')]
    .map((im) => ({
      im,
      rs: im.currentSrc || im.getAttribute('src') || im.getAttribute('data-src'),
    }))
    .filter(({ im, rs }) => {
      if (!rs) return false;
      const hay = `${im.alt} ${im.className} ${im.id} ${rs}`.toLowerCase();
      if (!/logo|brand|wordmark/.test(hay) || JUNK.test(hay)) return false;
      const r = im.getBoundingClientRect();
      return r.width >= 24 && r.height >= 12;
    })
    .map(({ im, rs }) => ({ rs: abs(rs), top: im.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top);
  if (li[0]) logo = li[0].rs;
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
  return {
    candidates: [...set.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([u]) => u),
    logo,
  };
};

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function scrapeOne(browser, m, i) {
  const proxy = proxyForSession(`m${i}`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'en-US',
    ...(proxy ? { proxy } : {}),
  });
  const page = await context.newPage();
  let res = { candidates: [], logo: null };
  try {
    await page.goto(`https://${m.domain}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(async () => {
      const mx = Math.min(document.body.scrollHeight, 8000);
      for (let y = 0; y < mx; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(700);
    res = await page.evaluate(COLLECT);
  } catch {
    /* */
  } finally {
    await context.close();
  }
  const out = { name: m.name };
  // header: best image yielding ≥640×360 16:9 crop
  if (m.needHeader) {
    let best = null,
      bestScore = -1;
    for (const url of res.candidates) {
      const d = await imageDimensions(url);
      if (!d || d.svg) continue;
      if (d.w < 640 || d.h < 360) continue;
      const cw = Math.min(d.w, (d.h * 16) / 9);
      const area = (cw * (cw * 9)) / 16;
      const score = area * (0.5 + 0.5 * (area / (d.w * d.h)));
      if (score > bestScore) {
        bestScore = score;
        best = { url, w: d.w, h: d.h, cw };
      }
    }
    if (best) {
      const tw = Math.min(1280, Math.floor(best.cw));
      const th = Math.round((tw * 9) / 16);
      out.headerUrl = `https://images.weserv.nl/?url=${encodeURIComponent(best.url)}&w=${tw}&h=${th}&fit=cover&output=jpg`;
      out.headerSource = 'site-proxied';
      out.srcDims = `${best.w}x${best.h}`;
    }
  }
  // logo if needed
  if (m.needLogo && res.logo && (await bigEnough(res.logo, 128))) {
    out.logoUrl = res.logo;
    out.logoSource = 'site-proxied';
  }
  return out;
}

async function main() {
  if (!process.env.PROXY_SERVER) {
    console.error(
      'PROXY_SERVER not set — run with PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD in env.',
    );
    process.exit(2);
  }
  const items = JSON.parse(readFileSync('/tmp/ctx-rescrape-targets.json', 'utf8'));
  let out = {};
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  const todo = items.filter((m) => !(m.id in out));
  console.log(
    `Proxied re-scrape: ${items.length} targets, ${Object.keys(out).length} done, ${todo.length} to do @ ${concurrency}\nproxy: ${process.env.PROXY_SERVER}\n`,
  );
  const browser = await chromium.launch();
  let idx = 0,
    done = 0;
  const flush = () => writeFileSync(outPath, JSON.stringify(out, null, 2));
  async function worker() {
    while (idx < todo.length) {
      const i = idx++;
      const m = todo[i];
      let r;
      try {
        r = await withTimeout(scrapeOne(browser, m, i), 60000);
      } catch {
        r = { name: m.name };
      }
      out[m.id] = r;
      done++;
      console.log(
        `${r.headerUrl ? '✓hdr' : '    '}${r.logoUrl ? ' ✓logo' : ''} ${m.name.slice(0, 32).padEnd(32)} ${m.domain.padEnd(24)} ${r.srcDims || ''}`,
      );
      if (done % 20 === 0) flush();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await browser.close();
  flush();
  const H = Object.values(out).filter((r) => r.headerUrl).length,
    L = Object.values(out).filter((r) => r.logoUrl).length;
  console.log(
    `\nDone. recovered headers:${H} logos:${L} of ${Object.keys(out).length}. Wrote ${outPath}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
