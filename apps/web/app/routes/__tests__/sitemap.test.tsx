import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A2-1714: the `/sitemap.xml` resource route is the only React Router
 * loader Loop runs server-side ("Web is a pure API client" in
 * CLAUDE.md, with sitemap as the documented exception). It had no
 * tests; a regression here silently breaks every public route's SEO
 * discovery without surfacing in the unit suite or e2e.
 *
 * These tests pin the loader's contract:
 *   - Always emits a valid sitemap with the static routes (homepage,
 *     /cashback, /calculator, /trustlines, /privacy, /terms) — even
 *     when the merchants fetch fails.
 *   - When merchants fetch succeeds, appends a `<url>` per merchant
 *     under `/cashback/:slug`.
 *   - XML escapes any merchant-name-derived content (defence-in-depth
 *     even though slugs are alphanumeric).
 *   - Cache headers: `public, max-age=300, s-maxage=3600`.
 *   - 200 + `application/xml; charset=utf-8` content-type.
 */

import { loader } from '../sitemap';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

const STATIC_PATHS = ['/', '/cashback', '/calculator', '/trustlines', '/privacy', '/terms'];

describe('sitemap loader', () => {
  it('emits the static routes when the merchants fetch returns null', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const res = await loader();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=3600');
    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const path of STATIC_PATHS) {
      expect(body).toContain(`<loc>https://loopfinance.io${path}</loc>`);
    }
  });

  it('emits the static routes when the merchants fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('upstream blew up'));
    const res = await loader();
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const path of STATIC_PATHS) {
      expect(body).toContain(`<loc>https://loopfinance.io${path}</loc>`);
    }
  });

  it('appends one /cashback/:slug entry per merchant when the fetch succeeds', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          asOf: '2026-04-20T00:00:00Z',
          merchants: [
            { name: 'Acme Coffee', cashbackPct: 5 },
            { name: 'Globex Tools', cashbackPct: 3 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await loader();
    const body = await res.text();
    expect(body).toContain('<loc>https://loopfinance.io/cashback/acme-coffee</loc>');
    expect(body).toContain('<loc>https://loopfinance.io/cashback/globex-tools</loc>');
    // lastmod for merchant entries should reflect the asOf date, not today
    expect(body).toContain('<lastmod>2026-04-20</lastmod>');
  });

  it('XML-escapes ampersand in URLs (defence-in-depth even for slug paths)', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          asOf: '2026-04-20T00:00:00Z',
          merchants: [{ name: 'Smith & Co', cashbackPct: 5 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await loader();
    const body = await res.text();
    // merchantSlug already lowercases + dashifies, so the raw `&`
    // never reaches the URL — but the test pins that no unescaped
    // `&` ever appears in any `<loc>` line.
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
