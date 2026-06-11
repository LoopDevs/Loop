#!/usr/bin/env node
/**
 * Merchant brand-image scraper v2 — our own, no third-party logo APIs.
 *
 * Renders each brand site in a real (Playwright) browser so JS-loaded
 * hero imagery is visible and we get the actual rendered dimensions,
 * then extracts:
 *
 *   logo   the header / nav logo image (alt|class|src contains "logo"),
 *          falling back to the largest apple-touch-icon
 *   cover  the largest on-page image closest to 16:9 (1.78), counting
 *          both <img> natural sizes and CSS hero background-images
 *
 * Domain resolution still uses Clearbit's keyless name→domain lookup
 * (it returns no images — just the domain — so it isn't a logo API).
 *
 * Generic catalogue SKUs with no brand site ("AirlineGift", game
 * top-ups, "Amex Prepaid") fall through to a curated category map
 * (icon-style logo + a stock category cover).
 *
 * Output: a reviewable JSON map. MUTATES NOTHING.
 *
 *   node scripts/scrape-merchant-images-v2.mjs --limit 12
 *   node scripts/scrape-merchant-images-v2.mjs --all --concurrency 4 --out /tmp/mi2.json
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const CATALOG = 'https://api.loopfinance.io/api/merchants/all';
const args = process.argv.slice(2);
const limit = args.includes('--all') ? Infinity : Number(args[args.indexOf('--limit') + 1] ?? 12);
const concurrency = Number(args[args.indexOf('--concurrency') + 1] ?? 3);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp/mi2.json';

// ── Curated fallbacks for generic, brandless SKUs ────────────────────
// Stock covers are Unsplash (permitted); icons are simple emoji-style
// markers the UI can render as a monogram-equivalent. Keyword-matched
// against the merchant name.
const CATEGORY_FALLBACKS = [
  {
    test: /\bairline|airlinegift|flight\b/i,
    category: 'airline',
    cover:
      'https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=1600&fm=jpg&q=70&fit=crop',
  },
  {
    test: /\bamex|american express|prepaid\b/i,
    category: 'prepaid-card',
    cover: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=1600&fm=jpg&q=70&fit=crop',
  },
  {
    test: /\bdiamond|coins|gems|top.?up|game|gaming|xbox|playstation|steam\b/i,
    category: 'gaming',
    cover: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1600&fm=jpg&q=70&fit=crop',
  },
  {
    test: /\bdine|dining|restaurant|carvery|pub\b/i,
    category: 'dining',
    cover:
      'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1600&fm=jpg&q=70&fit=crop',
  },
];

function categoryFallback(name) {
  for (const f of CATEGORY_FALLBACKS) if (f.test.test(name)) return f;
  return null;
}

// Universal last-resort cover so every merchant has *something* (a clean
// gift-card / retail scene) when no brand or category image is found.
const DEFAULT_COVER =
  'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1600&fm=jpg&q=70&fit=crop';

/** Two-letter brand initials for the monogram fallback. */
function initials(name) {
  const w = name
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  return (w[0] || name).slice(0, 2).toUpperCase();
}

/** Guaranteed generated monogram logo (keyless image service). */
function monogram(name) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(initials(name))}&size=256&background=1a56db&color=ffffff&bold=true&format=png`;
}

/** Brand favicon (returns the apple-touch-icon / hi-res icon for a domain). */
function favicon(domain) {
  return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
}

/** Validates a URL actually returns a real (non-null, non-tiny) image. */
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
    const len = Number(r.headers.get('content-length') || '0');
    return !(len && len < 500);
  } catch {
    return false;
  }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function cleanName(raw) {
  let n = raw;
  n = n.replace(/\s*[-–—]\s*\d+\s*(month|months|year|years|day|days|week|weeks)\b.*$/i, '');
  n = n.replace(/\b\d+\s*(month|months|year|years)\b/gi, '');
  n = n.replace(/\s*[/|].*$/, '');
  n = n.replace(/\s*\([^)]*\)\s*/g, ' ');
  n = n.replace(/\.com$/i, '');
  n = n.replace(/\s{2,}/g, ' ').trim();
  return n || raw;
}

async function resolveDomain(rawName) {
  const name = cleanName(rawName);
  try {
    const res = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list[0]?.domain) return list[0].domain;
    }
  } catch {
    /* fall through to guess */
  }
  // Wider net: guess "<slug>.com" and accept it if it actually resolves.
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug.length >= 3 && slug.length <= 30) {
    const guess = `${slug}.com`;
    try {
      const r = await fetch(`https://${guess}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(7000),
      });
      if (r.ok || r.status === 405 || r.status === 403) return guess;
    } catch {
      /* no such site */
    }
  }
  return null;
}

/** In-page extraction of the best logo + the best ~16:9 cover. */
const EXTRACT = () => {
  const abs = (u) => {
    try {
      return new URL(u, location.href).toString();
    } catch {
      return null;
    }
  };
  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute('content') : null;
  };
  // Real image src — lazy-loaded <img> often carry a "null"/placeholder
  // `src` with the true URL in data-src / srcset, which is what produced
  // the bogus ".../null" logos. Resolve the genuine one or return null.
  const realSrc = (im) => {
    const cands = [
      im.currentSrc,
      im.getAttribute('src'),
      im.getAttribute('data-src'),
      im.getAttribute('data-lazy-src'),
      im.getAttribute('data-original'),
      (im.getAttribute('srcset') || '').split(',').pop()?.trim().split(' ')[0],
    ];
    for (const c of cands) {
      if (!c) continue;
      const t = c.trim();
      if (!t || /(^|\/)(null|undefined)(\?|$)/i.test(t) || t.startsWith('data:')) continue;
      return t;
    }
    return null;
  };

  const imgs = [...document.querySelectorAll('img')];

  // ── Logo ──────────────────────────────────────────────────────────
  // Any img hinting logo/brand/wordmark, preferring one served from the
  // brand's own host and highest on the page (a header logo). Excludes
  // 3rd-party junk: cookie-consent banners, tracking pixels, social
  // icons, payment marks, app-store / trust badges.
  const JUNK =
    /cookielaw|onetrust|trustarc|cookiebot|cookieyes|termly|consent|usercentrics|osano|evidon|quantcast|gdpr|doubleclick|googletag|google-analytics|gstatic|fbcdn|facebook|twitter|x-icon|instagram|linkedin|youtube|tiktok|pinterest|snapchat|whatsapp|visa|mastercard|maestro|amex|discover|paypal|klarna|afterpay|applepay|googlepay|trustpilot|bazaarvoice|feefo|yotpo|app-?store|google-?play|play\.google|badge|award|sprite/i;
  const host = location.hostname.replace(/^www\./, '');
  let logo = null;
  const logoImgs = imgs
    .map((im) => ({ im, rs: realSrc(im) }))
    .filter(({ im, rs }) => {
      if (!rs) return false; // no genuine src (lazy placeholder)
      const hay = `${im.alt} ${im.className} ${im.id} ${rs}`.toLowerCase();
      if (!/logo|brand|wordmark/.test(hay)) return false;
      if (JUNK.test(hay)) return false;
      const r = im.getBoundingClientRect();
      if (r.width < 24 || r.height < 12) return false; // skip tiny sprites/icons
      return true;
    })
    .map(({ im, rs }) => {
      let sameHost = 0;
      try {
        sameHost = new URL(rs, location.href).hostname.includes(host) ? 0 : 1;
      } catch {
        sameHost = 1;
      }
      return { rs, sameHost, top: im.getBoundingClientRect().top };
    })
    // brand-host logos first, then topmost on the page
    .sort((a, b) => a.sameHost - b.sameHost || a.top - b.top);
  if (logoImgs.length) logo = abs(logoImgs[0].rs);
  if (!logo) logo = abs(meta('meta[property="og:logo"]'));
  if (!logo) {
    const icons = [...document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="icon"]')]
      .map((l) => ({
        href: l.getAttribute('href'),
        size: parseInt((l.getAttribute('sizes') || '0').split('x')[0], 10) || 0,
      }))
      .filter((i) => i.href && !JUNK.test(i.href))
      .sort((a, b) => b.size - a.size);
    if (icons.length && icons[0].href) logo = abs(icons[0].href);
  }

  // ── Cover (~16:9) ─────────────────────────────────────────────────
  // Candidates: <img> natural sizes, CSS hero background-images, and the
  // social-meta images (treated as 1200×630 ≈ 1.9, since they're built
  // to be covers). Pick the largest within a 1.45–2.1 ratio band.
  const TARGET = 16 / 9;
  let best = null;
  let bestScore = -1;
  const consider = (url, w, h) => {
    if (!url || w < 600 || h < 300) return;
    const r = w / h;
    if (r < 1.45 || r > 2.1) return;
    const score = w * h - Math.abs(r - TARGET) * 350000;
    if (score > bestScore) {
      bestScore = score;
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
      const rect = el.getBoundingClientRect();
      consider(m[1], Math.round(rect.width), Math.round(rect.height));
    }
  }
  const og = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  if (og) consider(og, 1200, 630);

  return { logo, cover: best };
};

async function scrapeOne(context, merchant) {
  const fb = categoryFallback(merchant.name);
  const domain = await resolveDomain(merchant.name);
  let scrapedLogo = null;
  let scrapedCover = null;

  if (domain) {
    const page = await context.newPage();
    try {
      await page.goto(`https://${domain}`, { waitUntil: 'load', timeout: 20000 });
      // Scroll through the page to trigger lazy-loaded logos + hero images,
      // then back to top, so realSrc/naturalWidth reflect the true assets.
      await page.evaluate(async () => {
        const max = Math.min(document.body.scrollHeight, 7200); // cap depth/time
        for (let y = 0; y < max; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 110));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(700);
      const ex = await page.evaluate(EXTRACT);
      scrapedLogo = ex.logo ?? null;
      scrapedCover = ex.cover ?? null;
    } catch {
      /* site failed to load — fall through to the ladders */
    } finally {
      await page.close();
    }
  }

  // ── Logo ladder (guaranteed): real scrape → brand favicon → monogram.
  let logoUrl;
  let logoSource;
  if (await validImage(scrapedLogo)) {
    logoUrl = scrapedLogo;
    logoSource = 'scrape';
  } else if (domain && (await validImage(favicon(domain)))) {
    logoUrl = favicon(domain);
    logoSource = 'favicon';
  } else {
    logoUrl = monogram(merchant.name);
    logoSource = 'monogram';
  }

  // ── Cover ladder (guaranteed): real 16:9 → category stock → default.
  let cardImageUrl;
  let coverSource;
  if (await validImage(scrapedCover)) {
    cardImageUrl = scrapedCover;
    coverSource = 'scrape';
  } else if (fb) {
    cardImageUrl = fb.cover;
    coverSource = 'category';
  } else {
    cardImageUrl = DEFAULT_COVER;
    coverSource = 'default';
  }

  return {
    name: merchant.name,
    domain,
    logoUrl,
    cardImageUrl,
    logoSource,
    coverSource,
    source: `${logoSource}/${coverSource}`,
  };
}

async function main() {
  // Source of truth: the authoritative CTX merchant dump (/tmp/ctx-all.json,
  // pulled from spend.ctx.com). Falls back to the Loop catalogue if absent.
  let merchants;
  try {
    const all = JSON.parse(readFileSync('/tmp/ctx-all.json', 'utf8'));
    merchants = all.filter((m) => !m.logoUrl || !m.cardImageUrl);
    console.log(
      `Source: /tmp/ctx-all.json (CTX authoritative) — ${merchants.length} missing images`,
    );
  } catch {
    const cat = await (await fetch(CATALOG, { signal: AbortSignal.timeout(20000) })).json();
    merchants = (cat.merchants ?? []).filter((m) => !m.logoUrl || !m.cardImageUrl);
    console.log('Source: Loop catalogue (CTX dump not found)');
  }
  if (limit !== Infinity) merchants = merchants.slice(0, limit);
  console.log(`Scraping ${merchants.length} merchant(s) at concurrency ${concurrency}…\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });

  const out = {};
  let logoHits = 0;
  let coverHits = 0;
  let idx = 0;
  async function worker() {
    while (idx < merchants.length) {
      const m = merchants[idx++];
      const r = await scrapeOne(context, m);
      out[m.id] = r;
      if (r.logoUrl) logoHits++;
      if (r.cardImageUrl) coverHits++;
      console.log(
        `${r.logoUrl || r.cardImageUrl ? '✓' : '○'} ${m.name.slice(0, 32).padEnd(32)} ${(r.domain ?? '—').padEnd(24)} logo:${r.logoUrl ? 'Y' : '-'} cover:${r.cardImageUrl ? 'Y' : '-'}${r.source ? ' [' + r.source + ']' : ''}`,
      );
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  await browser.close();
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `\nDone. ${merchants.length} processed — logo:${logoHits} cover:${coverHits}. Wrote ${outPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
