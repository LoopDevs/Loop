/** ADR 034 Phase 2 — `/` geo-redirect loader. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loader } from '../home-geo-redirect';

type Args = Parameters<typeof loader>[0];

const run = async (
  ua: string,
  cookie?: string,
  extra?: Record<string, string>,
): Promise<Response | null> => {
  const headers: Record<string, string> = { 'user-agent': ua, ...extra };
  if (cookie) headers.cookie = cookie;
  const request = new Request('https://loopfinance.io/', { headers });
  try {
    return await loader({ request } as unknown as Args);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('home-geo-redirect loader', () => {
  it('does NOT redirect bots — returns null so the x-default home renders at /', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await run('Googlebot/2.1 (+http://www.google.com/bot.html)');
    expect(res).toBeNull();
    // Bots never hit the geo endpoint.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('302-redirects a human to the geo-resolved country', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ countryCode: 'GB', region: 'UK' }), { status: 200 }),
      ),
    );
    const res = await run(CHROME);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(302);
    expect(res!.headers.get('location')).toBe('/gb/en');
  });

  it('falls back to the default market when geo is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const res = await run(CHROME);
    expect(res!.status).toBe(302);
    expect(res!.headers.get('location')).toBe('/us/en');
  });

  it('falls back to Accept-Language when geo-IP is empty (the UK-user-gets-US fix)', async () => {
    // MaxMind has no entry for the visitor's ISP → empty country. Without the
    // Accept-Language backstop this defaults to US; a real en-GB browser is GB.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ countryCode: '', region: 'US' }), { status: 200 }),
      ),
    );
    const res = await run(CHROME, undefined, { 'accept-language': 'en-GB,en;q=0.9' });
    expect(res!.headers.get('location')).toBe('/gb/en');
  });

  it('prefers an edge geo header (Cloudflare CF-IPCountry) and skips the backend geo call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await run(CHROME, undefined, { 'cf-ipcountry': 'GB' });
    expect(res!.headers.get('location')).toBe('/gb/en');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default market for an unrouted geo country', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ countryCode: 'JP', region: 'US' }), { status: 200 }),
      ),
    );
    const res = await run(CHROME);
    expect(res!.headers.get('location')).toBe('/us/en');
  });

  it('honours the saved country cookie over geo-IP (ADR §7 precedence)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ countryCode: 'GB', region: 'UK' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await run(CHROME, 'loop_country=de');
    expect(res!.headers.get('location')).toBe('/de/en');
    // Cookie short-circuits the geo lookup entirely.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
