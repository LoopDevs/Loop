import { merchantSlug, type PublicTopCashbackMerchantsResponse } from '@loop/shared';

/**
 * `/sitemap.xml` — crawler sitemap (#650).
 *
 * Lists the public routes Google + Bing should crawl: the
 * homepage, the /cashback index shipped in #649, and one
 * /cashback/:slug entry per active merchant (from the public
 * top-cashback-merchants endpoint, ADR 020 Tier-1, shipped in
 * #609/#647).
 *
 * Resource route — exports only a `loader` that returns the
 * XML response directly; no React component, no hydration. The
 * server-side data fetch here is a deliberate, scoped exception
 * to the CLAUDE.md "web is a pure API client" rule: a sitemap is
 * inherently server-rendered content for crawlers and has no
 * static-export counterpart (mobile doesn't serve HTTP).
 * Everything else on the web stays client-fetched.
 *
 * Fails open: if the merchants fetch errors, we emit the
 * sitemap with just the two static routes rather than 500ing —
 * a partial sitemap is strictly better for SEO than a missing
 * one.
 */

const PUBLIC_BASE_URL = 'https://loopfinance.io';
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

function urlTag(loc: string, lastmod: string, changefreq: string, priority: string): string {
  return [
    '  <url>',
    `    <loc>${escapeXml(loc)}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n');
}

export async function loader(): Promise<Response> {
  const response = await fetchMerchants();
  const now = new Date().toISOString().slice(0, 10);
  const lastmod = response?.asOf.slice(0, 10) ?? now;

  const urls: string[] = [
    urlTag(`${PUBLIC_BASE_URL}/`, now, 'weekly', '1.0'),
    urlTag(`${PUBLIC_BASE_URL}/cashback`, lastmod, 'daily', '0.9'),
    // Trustlines page is near-static — issuer accounts only rotate
    // via ADR-015 key ceremony, which is rare. Monthly changefreq.
    urlTag(`${PUBLIC_BASE_URL}/trustlines`, now, 'monthly', '0.7'),
  ];

  if (response !== null) {
    for (const m of response.merchants) {
      urls.push(
        urlTag(`${PUBLIC_BASE_URL}/cashback/${merchantSlug(m.name)}`, lastmod, 'weekly', '0.8'),
      );
    }
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
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
