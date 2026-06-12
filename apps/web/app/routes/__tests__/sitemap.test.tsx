import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A2-1714 / ADR 034 §5: the `/sitemap.xml` resource route is one of the two
 * React Router loaders Loop runs server-side ("Web is a pure API client" in
 * CLAUDE.md). It had no tests; a regression here silently breaks every public
 * route's SEO discovery without surfacing in the unit suite or e2e.
 *
 * These tests pin the loader's contract:
 *   - The country-varying landing pages (home + /cashback) are emitted once per
 *     routed country with a reciprocal `hreflang` + `x-default` block.
 *   - The static pages + per-merchant pages stay single `x-default` (us/en) URLs.
 *   - Fails open to the static set when the merchants fetch errors.
 *   - XML-escapes URL content; correct cache + content-type headers.
 */

import { loader } from '../sitemap';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

// Every locale-agnostic page resolves to its us/en (x-default) URL; the two
// country-varying pages resolve to their us/en variant (plus 22 siblings).
const XDEFAULT_LOCS = [
  'https://loopfinance.io/us/en', // home
  'https://loopfinance.io/us/en/cashback',
  'https://loopfinance.io/us/en/calculator',
  'https://loopfinance.io/us/en/trustlines',
  'https://loopfinance.io/us/en/privacy',
  'https://loopfinance.io/us/en/terms',
];

describe('sitemap loader', () => {
  it('emits the localized static routes when the merchants fetch returns null', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const res = await loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=3600');
    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    for (const loc of XDEFAULT_LOCS) {
      expect(body).toContain(`<loc>${loc}</loc>`);
    }
  });

  it('emits per-country variants + reciprocal hreflang for the home + cashback pages', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const body = await (await loader()).text();
    // Per-country <loc> for home and /cashback.
    expect(body).toContain('<loc>https://loopfinance.io/gb/en</loc>');
    expect(body).toContain('<loc>https://loopfinance.io/de/en/cashback</loc>');
    // Reciprocal hreflang + x-default alternates.
    expect(body).toContain('<xhtml:link rel="alternate" hreflang="x-default"');
    expect(body).toContain(
      '<xhtml:link rel="alternate" hreflang="en-GB" href="https://loopfinance.io/gb/en"/>',
    );
    // The static + merchant pages carry NO per-country hreflang block.
    expect(body).not.toContain('href="https://loopfinance.io/gb/en/privacy"');
  });

  it('emits the static routes when the merchants fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('upstream blew up'));
    const body = await (await loader()).text();
    for (const loc of XDEFAULT_LOCS) {
      expect(body).toContain(`<loc>${loc}</loc>`);
    }
  });

  it('appends one us/en /cashback/:slug entry per merchant when the fetch succeeds', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          asOf: '2026-04-20T00:00:00Z',
          // The backend emits a country-aware `slug` (merchantSlug); the
          // sitemap links with it directly rather than re-deriving from name.
          merchants: [
            { name: 'Acme Coffee', slug: 'acme-coffee', userCashbackPct: '5.00' },
            { name: 'Globex Tools', slug: 'globex-tools', userCashbackPct: '3.00' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const body = await (await loader()).text();
    expect(body).toContain('<loc>https://loopfinance.io/us/en/cashback/acme-coffee</loc>');
    expect(body).toContain('<loc>https://loopfinance.io/us/en/cashback/globex-tools</loc>');
    expect(body).toContain('<lastmod>2026-04-20</lastmod>');
  });

  it('does not emit an unescaped ampersand inside any <loc>', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          asOf: '2026-04-20T00:00:00Z',
          merchants: [{ name: 'Smith & Co', slug: 'smith-co', userCashbackPct: '5.00' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const body = await (await loader()).text();
    expect(body).not.toMatch(/<loc>[^<]*&[^a-z][^<]*<\/loc>/);
  });

  it('hits the public top-cashback-merchants endpoint with the configured limit', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    await loader();
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('/api/public/top-cashback-merchants');
    expect(url).toContain('limit=50');
  });
});
