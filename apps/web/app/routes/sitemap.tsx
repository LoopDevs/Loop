import { COUNTRIES, DEFAULT_LANG, type PublicTopCashbackMerchantsResponse } from '@loop/shared';
import { hreflangAlternates, localeUrl } from '~/i18n/seo';

/**
 * `/sitemap.xml` — crawler sitemap (#650, ADR 034 §5).
 *
 * Lists the public routes Google + Bing should crawl. The country-varying
 * landing pages — the homepage and the /cashback index — are emitted **once per
 * routed country** (`/us/en`, `/gb/en`, `/de/en`, …) with a reciprocal
 * `hreflang` + `x-default` block, so Google serves a UK searcher the `/gb/en`
 * page instead of treating all markets as one URL. Per-merchant `/cashback/:slug`
 * pages and the static legal/utility pages stay single `x-default` (`us/en`)
 * URLs — the public merchant feed carries no country/currency yet, so a
 * per-country merchant variant would be a thin, irrelevant page. Their localized
 * mounts self-canonical when crawled via internal links.
 *
 * Resource route — exports only a `loader` that returns the XML response
 * directly; no React component, no hydration. The server-side data fetch here is
 * a deliberate, scoped exception to the CLAUDE.md "web is a pure API client"
 * rule: a sitemap is inherently server-rendered content for crawlers and has no
 * static-export counterpart (mobile doesn't serve HTTP). Everything else on the
 * web stays client-fetched.
 *
 * Fails open: if the merchants fetch errors, we emit the sitemap with just the
 * static routes rather than 500ing — a partial sitemap is strictly better for
 * SEO than a missing one.
 */

const MERCHANT_LIMIT = 50;

// Resolved server-side at request time. Baked in at build time by
// Vite when rendered on the SSR server (`import.meta.env` carries
// the VITE_API_URL the build ran with), falling back to the Fly
// internal service DNS when called through the web container's
// runtime.
function apiBaseUrl(): string {
  return import.meta.env.VITE_API_URL ?? 'https://api.loopfinance.io';
}

async function fetchMerchants(): Promise<PublicTopCashbackMerchantsResponse | null> {
  try {
    const res = await fetch(
      `${apiBaseUrl()}/api/public/top-cashback-merchants?limit=${MERCHANT_LIMIT}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicTopCashbackMerchantsResponse;
  } catch {
    return null;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function urlTag(
  loc: string,
  lastmod: string,
  changefreq: string,
  priority: string,
  alternates?: string,
): string {
  const lines = [
    '  <url>',
    `    <loc>${escapeXml(loc)}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority}</priority>`,
  ];
  if (alternates) lines.push(alternates);
  lines.push('  </url>');
  return lines.join('\n');
}

/** One `<url>` per routed country for a country-varying page, each carrying the
 * shared reciprocal `hreflang` + `x-default` block. */
function localizedPage(
  path: string,
  lastmod: string,
  changefreq: string,
  priority: string,
): string[] {
  const alternates = hreflangAlternates(path);
  return COUNTRIES.map((c) =>
    urlTag(localeUrl(c.code, DEFAULT_LANG, path), lastmod, changefreq, priority, alternates),
  );
}

/** `x-default` (us/en) URL for a country-agnostic page (legal/utility/merchant). */
function xDefault(path: string): string {
  return localeUrl('us', DEFAULT_LANG, path);
}

export async function loader(): Promise<Response> {
  const response = await fetchMerchants();
  const now = new Date().toISOString().slice(0, 10);
  const lastmod = response?.asOf.slice(0, 10) ?? now;

  const urls: string[] = [
    // Country-varying landing pages — one entry per country with reciprocal
    // hreflang so Google ranks each market (ADR 034 §5).
    ...localizedPage('/', now, 'weekly', '1.0'),
    ...localizedPage('/cashback', lastmod, 'daily', '0.9'),
    // Standalone cashback calculator (#746) — discovery path for
    // visitors who haven't landed on a /cashback/:slug page yet.
    urlTag(xDefault('/calculator'), now, 'weekly', '0.8'),
    // Trustlines page is near-static — issuer accounts only rotate
    // via ADR-015 key ceremony, which is rare. Monthly changefreq.
    urlTag(xDefault('/trustlines'), now, 'monthly', '0.7'),
    // Legal pages — yearly changefreq, low priority (required for
    // App Store submission but not the primary acquisition surface).
    urlTag(xDefault('/privacy'), now, 'yearly', '0.3'),
    urlTag(xDefault('/terms'), now, 'yearly', '0.3'),
  ];

  if (response !== null) {
    for (const m of response.merchants) {
      urls.push(urlTag(xDefault(`/cashback/${m.slug}`), lastmod, 'weekly', '0.8'));
    }
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // 1h edge / 5m client is a good trade for a list of 50
      // near-static URLs — crawler revisits are cheap and we
      // don't want a stale sitemap blocking a new merchant's
      // SEO for a day.
      'cache-control': 'public, max-age=300, s-maxage=3600',
    },
  });
}
