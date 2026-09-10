import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

// vi.hoisted runs in the hoisted scope so configState is available to
// vi.mock factories. `proxy.ts` only branches on the deployment
// environment (the SSRF guard relaxes outside production).
const { configState } = vi.hoisted(() => ({
  configState: { env: 'development' as 'development' | 'production' | 'test' },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, env: configState.env };
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// ADR 050: the proxy resolves URLs from the merchant + location stores.
// Both are mocked mutable so each test controls what resolves.
const { storeState } = vi.hoisted(() => ({
  storeState: {
    merchants: new Map<string, Record<string, unknown>>(),
    pinByMerchant: new Map<string, string>(),
  },
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [...storeState.merchants.values()],
    merchantsById: storeState.merchants,
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  getMapPinUrl: (merchantId: string) => storeState.pinByMerchant.get(merchantId) ?? null,
}));

vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

// Mock sharp — native module. The handler calls `sharp(buffer).metadata()`
// first to decide whether to output JPEG (opaque) or WebP
// (alpha-preserving), so the mock must respond to both `.metadata()` and
// the encoder chain. Default: hasAlpha=false → JPEG path.
const mockSharpMetadata = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ hasAlpha: false, format: 'jpeg' }),
);
const mockSharpFlatten = vi.hoisted(() => vi.fn());
vi.mock('sharp', () => ({
  default: vi.fn(() => {
    const pipeline = {
      metadata: mockSharpMetadata,
      flatten: mockSharpFlatten,
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      webp: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue({
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        info: { width: 100, height: 100 },
      }),
    };
    mockSharpFlatten.mockReturnValue(pipeline);
    return pipeline;
  }),
}));

// Mock DNS — default to a public IP. Production-mode tests override to
// simulate private-IP resolution.
const mockDnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({
  lookup: mockDnsLookup,
}));

import { app } from '../../app.js';
import {
  __getImageCacheStatsForTests,
  __resetImageCacheForTests,
  __imageUpstream,
} from '../proxy.js';

// Stub the upstream transport with a mock returning synthetic
// `Response`s so tests exercise resolution/resize/cache handling
// without real sockets. The connect-time rebind defence is proven in
// `../ssrf-guard.test.ts`.
const mockFetch = vi.fn();

const MERCHANT = {
  id: 'm-1',
  name: 'Airbnb Canada',
  enabled: true,
  logoUrl: 'https://cdn.example.com/logo.png',
  cardImageUrl: 'https://cdn.example.com/card.jpg',
  updatedAt: '2026-08-26T10:00:00Z',
};

beforeEach(() => {
  mockFetch.mockReset();
  __imageUpstream.fetch = mockFetch;
  mockDnsLookup.mockReset();
  mockSharpMetadata.mockReset();
  mockSharpMetadata.mockResolvedValue({ hasAlpha: false, format: 'jpeg' });
  mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  configState.env = 'development';
  storeState.merchants = new Map([[MERCHANT.id, MERCHANT]]);
  storeState.pinByMerchant = new Map();
  __resetImageCacheForTests();
});

function fakeImageResponse(): Response {
  const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.byteLength) },
  });
}

describe('GET /api/image — reference resolution (ADR 050)', () => {
  it('rejects a missing merchantId with 400', async () => {
    const res = await app.request('/api/image?kind=logo');
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing or unknown kind with 400', async () => {
    expect((await app.request('/api/image?merchantId=m-1')).status).toBe(400);
    expect((await app.request('/api/image?merchantId=m-1&kind=banner')).status).toBe(400);
  });

  it('rejects a url param shape entirely — no URL-driven fetching', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    );
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('404s for an unknown merchant', async () => {
    const res = await app.request('/api/image?merchantId=nope&kind=logo');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('NOT_FOUND');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('404s when the merchant has no image of the requested kind', async () => {
    storeState.merchants.set('m-2', { id: 'm-2', name: 'No Images', enabled: true });
    const res = await app.request('/api/image?merchantId=m-2&kind=card');
    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves kind=logo from the catalog and fetches that URL', async () => {
    mockFetch.mockResolvedValueOnce(fakeImageResponse());
    const res = await app.request('/api/image?merchantId=m-1&kind=logo&width=160');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toContain('max-age=604800');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/logo.png',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('resolves kind=pin from the locations feed, falling back to the logo', async () => {
    storeState.pinByMerchant.set('m-1', 'https://cdn.example.com/pin.png');
    mockFetch.mockResolvedValue(fakeImageResponse());

    expect((await app.request('/api/image?merchantId=m-1&kind=pin')).status).toBe(200);
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://cdn.example.com/pin.png');

    storeState.pinByMerchant.clear();
    expect((await app.request('/api/image?merchantId=m-1&kind=pin&width=64')).status).toBe(200);
    expect(String(mockFetch.mock.calls[1]![0])).toBe('https://cdn.example.com/logo.png');
  });

  it('fetches loopback catalog URLs outside production (local CTX file hosts)', async () => {
    storeState.merchants.set('m-1', {
      ...MERCHANT,
      logoUrl: 'http://localhost:7777/files/abc/download',
    });
    mockFetch.mockResolvedValueOnce(fakeImageResponse());
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(200);
    expect(String(mockFetch.mock.calls[0]![0])).toBe('http://localhost:7777/files/abc/download');
  });

  it('rejects a non-HTTPS resolved URL in production with 502', async () => {
    configState.env = 'production';
    storeState.merchants.set('m-1', { ...MERCHANT, logoUrl: 'http://cdn.example.com/logo.png' });
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(502);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a resolved URL that resolves to a private IP in production with 502', async () => {
    configState.env = 'production';
    mockDnsLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(502);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/image — upstream hardening', () => {
  it('rejects upstream 302 redirect', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com' } }),
    );
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('UPSTREAM_REDIRECT');
  });

  it('rejects non-image Content-Type (e.g. HTML from a misconfigured origin)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('NOT_AN_IMAGE');
  });

  it('rejects upstream Content-Length exceeding 10MB', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8]), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(50 * 1024 * 1024),
        },
      }),
    );
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('IMAGE_TOO_LARGE');
  });

  it('outputs WebP when input has an alpha channel (transparent logos)', async () => {
    mockSharpMetadata.mockResolvedValueOnce({ hasAlpha: true, format: 'png' });
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
      }),
    );
    const res = await app.request('/api/image?merchantId=m-1&kind=logo');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
  });

  it('outputs JPEG when input has no alpha channel (default path)', async () => {
    mockFetch.mockResolvedValueOnce(fakeImageResponse());
    const res = await app.request('/api/image?merchantId=m-1&kind=card');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });
});

describe('GET /api/image — LRU cache', () => {
  it('serves repeats from cache and treats a new `v` as a miss', async () => {
    mockFetch.mockResolvedValue(fakeImageResponse());
    const base = '/api/image?merchantId=m-1&kind=logo';

    expect((await app.request(`${base}&v=2026-08-01`)).status).toBe(200);
    expect((await app.request(`${base}&v=2026-08-01`)).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Bumped v (CTX merchant `updatedAt` changed) → fresh upstream
    // fetch, second cache entry.
    expect((await app.request(`${base}&v=2026-08-26`)).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(__getImageCacheStatsForTests().entries).toBe(2);

    // `v` must never reach the upstream fetch URL.
    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).toBe('https://cdn.example.com/logo.png');
    }
  });

  it('does not drift the byte counter when an expired entry is overwritten', async () => {
    mockFetch.mockResolvedValue(fakeImageResponse());
    const url = '/api/image?merchantId=m-1&kind=logo';

    const first = await app.request(url);
    expect(first.status).toBe(200);
    const afterFirst = __getImageCacheStatsForTests();
    expect(afterFirst.entries).toBe(1);
    expect(afterFirst.totalBytes).toBeGreaterThan(0);

    // Jump past the 7-day TTL so the cached entry is stale: the next
    // request refetches and overwrites the same key. Before the fix,
    // the old entry's bytes were never subtracted, so the counter
    // double-counted every refresh (comprehensive-audit 2026-06-11,
    // P10) until the LRU evicted everything on sight.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 8 * 24 * 60 * 60 * 1000);
    try {
      const second = await app.request(url);
      expect(second.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }

    const afterSecond = __getImageCacheStatsForTests();
    expect(afterSecond.entries).toBe(1);
    expect(afterSecond.totalBytes).toBe(afterFirst.totalBytes);
  });
});
