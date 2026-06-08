#!/usr/bin/env node
/**
 * Merchant brand-image scraper (one-off data-enrichment tool).
 *
 * The CTX catalogue ships ~87% of merchants with no logo / card image.
 * Loop has express permission to use brand media from the merchants'
 * own sites, so this resolves each merchant to its brand domain and
 * pulls a real logo + cover photo straight from that site:
 *
 *   name → domain        Clearbit company autocomplete (keyless)
 *   cover (cardImage)    the site's <meta og:image>
 *   logo                 best of <link apple-touch-icon> / icon, then
 *                        DuckDuckGo icon service as a fallback
 *
 * Output is a reviewable JSON map { id → { name, domain, logoUrl,
 * cardImageUrl, ... } }. It MUTATES NOTHING — populating spend.ctx.com
 * is a separate, explicit step. Run a small `--limit` first to eyeball
 * quality, then scale.
 *
 * Usage:
 *   node scripts/scrape-merchant-images.mjs --limit 20
 *   node scripts/scrape-merchant-images.mjs --all --out /tmp/merchant-images.json
 */
import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const CATALOG = 'https://api.loopfinance.io/api/merchants/all';

const args = process.argv.slice(2);
const limit = args.includes('--all') ? Infinity : Number(args[args.indexOf('--limit') + 1] ?? 20);
const outPath = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : '/tmp/merchant-images.json';
const onlyMissing = !args.includes('--all-merchants'); // default: only the ones lacking images

function timeout(ms) {
  return AbortSignal.timeout(ms);
}

/**
 * Strips the catalogue noise that wrecks brand matching: duration /
 * denomination suffixes ("- 12 Months", "12 Month"), store-variant
 * slashes ("Albertsons/Safeway" → "Albertsons"), trailing ".com",
 * and bracketed qualifiers.
 */
export function cleanName(raw) {
  let n = raw;
  n = n.replace(/\s*[-–—]\s*\d+\s*(month|months|year|years|day|days|week|weeks)\b.*$/i, '');
  n = n.replace(/\b\d+\s*(month|months|year|years)\b/gi, '');
  n = n.replace(/\s*[/|].*$/, ''); // "Albertsons/Safeway" → "Albertsons"
  n = n.replace(/\s*\([^)]*\)\s*/g, ' '); // drop "(US)" etc.
  n = n.replace(/\.com$/i, '');
  n = n.replace(/\s{2,}/g, ' ').trim();
  return n || raw;
}

/** Does the resolved domain plausibly belong to the brand name? */
function domainMatchesName(name, domain) {
  const label = domain
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const folded = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (label.length < 3 || folded.length < 3) return true; // too short to judge
  return label.includes(folded.slice(0, 6)) || folded.includes(label.slice(0, 6));
}

/** name → best brand domain via Clearbit autocomplete (cleaned + sanity-checked). */
async function resolveDomain(rawName) {
  const name = cleanName(rawName);
  try {
    const res = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`,
      { signal: timeout(8000) },
    );
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    // Prefer the first result whose domain plausibly matches the name;
    // fall back to the top result flagged as low-confidence.
    const matched = list.find((c) => c.domain && domainMatchesName(name, c.domain));
    if (matched) return { domain: matched.domain, confident: true };
    return list[0]?.domain ? { domain: list[0].domain, confident: false } : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort "find a big wide hero image" fallback for sites with no
 * social-meta cover. Scans <img> tags, scores ones whose width attr or
 * URL hints at a large landscape asset (1920/1600/1200, hero/banner/
 * cover/slide), and returns the highest-scoring absolute https image.
 */
function largestHeroImage(html, base) {
  let best = null;
  let bestScore = 0;
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const t = tag[0];
    const srcM = t.match(/\bsrc=["']([^"']+)["']/i) || t.match(/\bdata-src=["']([^"']+)["']/i);
    if (!srcM) continue;
    const url = absolutize(srcM[1], base);
    if (!url || !/^https:/i.test(url)) continue;
    if (/\.svg(\?|$)/i.test(url)) continue; // svgs are usually logos/icons, not covers
    const wM = t.match(/\bwidth=["']?(\d{3,5})/i);
    const w = wM ? parseInt(wM[1], 10) : 0;
    let score = w;
    if (/\b(hero|banner|cover|slide|masthead|featured)\b/i.test(t)) score += 1500;
    if (/(1920|1600|1280|1200)/.test(url)) score += 800;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return bestScore >= 1000 ? best : null;
}

/** Resolve a possibly-relative URL against a base origin. */
function absolutize(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

/** Pull og:image (cover) + best icon (logo) out of a homepage. */
async function scrapeSite(domain) {
  const base = `https://${domain}`;
  let html = '';
  let finalUrl = base;
  try {
    const res = await fetch(base, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: timeout(12000),
    });
    finalUrl = res.url || base;
    html = await res.text();
  } catch {
    return { cardImageUrl: null, logoUrl: null };
  }

  // Cover, best-first: og:image → twitter:image → <link image_src> →
  // the largest hero/banner <img> we can find on the homepage. The
  // last one catches sites that don't set social meta but do have a
  // big wide hero (the "1920×1080 on their site" case).
  const og =
    html.match(
      /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i,
    ) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
  let cardImageUrl = og ? absolutize(og[1], finalUrl) : null;
  if (cardImageUrl === null) cardImageUrl = largestHeroImage(html, finalUrl);

  // Logo = highest-res apple-touch-icon, else any icon link.
  const iconLinks = [...html.matchAll(/<link[^>]+rel=["']([^"']*icon[^"']*)["'][^>]*>/gi)].map(
    (m) => m[0],
  );
  let logoUrl = null;
  for (const tag of iconLinks) {
    if (/apple-touch-icon/i.test(tag)) {
      const href = tag.match(/href=["']([^"']+)["']/i);
      if (href) {
        logoUrl = absolutize(href[1], finalUrl);
        break;
      }
    }
  }
  if (logoUrl === null) {
    for (const tag of iconLinks) {
      const href = tag.match(/href=["']([^"']+)["']/i);
      if (href) {
        logoUrl = absolutize(href[1], finalUrl);
        break;
      }
    }
  }
  // Reliable fallback: DuckDuckGo's icon service (keyless, decent res).
  if (logoUrl === null) logoUrl = `https://icons.duckduckgo.com/ip3/${domain}.ico`;

  return { cardImageUrl, logoUrl };
}

/** HEAD/GET-validate that a URL actually returns an image. */
async function validateImage(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      signal: timeout(10000),
    });
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') ?? '';
    return ct.startsWith('image/');
  } catch {
    return false;
  }
}

async function main() {
  console.log(`Fetching catalogue from ${CATALOG} …`);
  const cat = await (await fetch(CATALOG, { signal: timeout(20000) })).json();
  let merchants = cat.merchants ?? [];
  if (onlyMissing) merchants = merchants.filter((m) => !m.logoUrl || !m.cardImageUrl);
  if (limit !== Infinity) merchants = merchants.slice(0, limit);
  console.log(`Processing ${merchants.length} merchant(s)…\n`);

  const out = {};
  let hits = 0;
  let logoHits = 0;
  let coverHits = 0;
  for (const m of merchants) {
    const resolved = await resolveDomain(m.name);
    if (!resolved) {
      console.log(`✗ ${m.name.padEnd(34)} no domain`);
      out[m.id] = {
        name: m.name,
        domain: null,
        confident: false,
        logoUrl: null,
        cardImageUrl: null,
      };
      continue;
    }
    const { domain, confident } = resolved;
    const { cardImageUrl, logoUrl } = await scrapeSite(domain);
    const coverOk = await validateImage(cardImageUrl);
    const logoOk = await validateImage(logoUrl);
    if (coverOk) coverHits++;
    if (logoOk) logoHits++;
    if (coverOk || logoOk) hits++;
    out[m.id] = {
      name: m.name,
      domain,
      confident,
      logoUrl: logoOk ? logoUrl : null,
      cardImageUrl: coverOk ? cardImageUrl : null,
    };
    console.log(
      `${coverOk || logoOk ? '✓' : '○'}${confident ? ' ' : '?'}${m.name.padEnd(33)} ${domain.padEnd(24)} logo:${logoOk ? 'Y' : '-'} cover:${coverOk ? 'Y' : '-'}`,
    );
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `\nDone. ${hits}/${merchants.length} with at least one image (logo:${logoHits} cover:${coverHits}). Wrote ${outPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
