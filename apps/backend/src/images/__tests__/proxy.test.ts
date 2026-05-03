import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs in the hoisted scope so mockEnv is available to vi.mock factories
const mockEnv = vi.hoisted(() => {
  const obj: Record<string, unknown> = {
    PORT: '8080',
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
  };
  return obj;
});

vi.mock('../../env.js', () => ({
  env: mockEnv,
}));

// Mock logger to suppress output
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock background refresh to prevent timers and network calls
vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

// Mock clustering handler to avoid proto import
vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

// Mock sharp — native module, not needed for URL validation tests. The
// handler now calls `sharp(buffer).metadata()` first to decide whether
// to output JPEG (opaque) or WebP (alpha-preserving), so the mock must
// respond to both `.metadata()` and the encoder chain. Default:
// hasAlpha=false → JPEG path.
const mockSharpMetadata = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ hasAlpha: false, format: 'jpeg' }),
);
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    metadata: mockSharpMetadata,
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      info: { width: 100, height: 100 },
    }),
  })),
}));

// Mock DNS — default to returning a public IP for any hostname. Individual
// tests override via mockDnsLookup.mockResolvedValueOnce(...) to simulate
// DNS rebinding or private-IP resolution.
const mockDnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({
  lookup: mockDnsLookup,
}));

import { app } from '../../app.js';

// Mock global fetch for upstream image fetches
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockDnsLookup.mockReset();
  mockSharpMetadata.mockReset();
  mockSharpMetadata.mockResolvedValue({ hasAlpha: false, format: 'jpeg' });
  // Default DNS: everything resolves to a harmless public IP. Tests that
  // care about resolution (rebinding, private-IP lookup) override per-call.
  mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  // Reset env to defaults before each test
  mockEnv.NODE_ENV = 'development';
  delete mockEnv.IMAGE_PROXY_ALLOWED_HOSTS;
});

// Tiny valid JPEG-like response for tests that need a successful upstream
function fakeImageResponse(): Response {
  const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.byteLength) },
  });
}

describe('GET /api/image — SSRF validation', () => {
  it('rejects missing url param with 400', async () => {
    const res = await app.request('/api/image');
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('url is required');
  });

  it('rejects http://localhost/image.jpg (private address)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('http://localhost/image.jpg')}`,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects https://127.0.0.1/image.jpg (loopback)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://127.0.0.1/image.jpg')}`,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects https://10.0.0.1/image.jpg (private range)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://10.0.0.1/image.jpg')}`,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects https://192.168.1.1/image.jpg (private range)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://192.168.1.1/image.jpg')}`,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects https://[::1]/image.jpg (IPv6 loopback)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://[::1]/image.jpg')}`,
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Private and loopback');
  });

  it('allows valid HTTPS URL when upstream succeeds', async () => {
    mockFetch.mockResolvedValueOnce(fakeImageResponse());

    const url = 'https://cdn.example.com/photos/card.jpg';
    const res = await app.request(`/api/image?url=${encodeURIComponent(url)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toContain('max-age=604800');

    // Verify fetch was called with the original URL
    expect(mockFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects hostname not in IMAGE_PROXY_ALLOWED_HOSTS', async () => {
    mockEnv.IMAGE_PROXY_ALLOWED_HOSTS = 'cdn.example.com';

    const url = 'https://evil.attacker.com/image.jpg';
    const res = await app.request(`/api/image?url=${encodeURIComponent(url)}`);

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('not in the allowed list');
  });

  it('in production mode, rejects HTTP URLs (only HTTPS allowed)', async () => {
    mockEnv.NODE_ENV = 'production';

    const url = 'http://cdn.example.com/image.jpg';
    const res = await app.request(`/api/image?url=${encodeURIComponent(url)}`);

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Only HTTPS');
  });

  it('rejects https://0.0.0.0/image.jpg (unspecified)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://0.0.0.0/image.jpg')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects https://169.254.169.254/ (cloud metadata, link-local)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://169.254.169.254/latest/meta-data/')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects https://[::ffff:127.0.0.1]/ (IPv4-mapped IPv6 loopback)', async () => {
    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://[::ffff:127.0.0.1]/image.jpg')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('Private and loopback');
  });

  it('rejects hostname that resolves to a private IP (DNS rebinding defense)', async () => {
    // Hostname looks public, but DNS resolves to AWS metadata address.
    mockDnsLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);

    const url = 'https://metadata-proxy.evil.com/latest/meta-data/';
    const res = await app.request(`/api/image?url=${encodeURIComponent(url)}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('Private and loopback');
    // Fetch must not have been called — validation blocks before any network I/O.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects when DNS resolution returns mixed public + private addresses', async () => {
    // Attacker advertises one public and one private A record.
    mockDnsLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://mixed.evil.com/x.jpg')}`,
    );
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects when DNS lookup fails', async () => {
    mockDnsLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://nonexistent.invalid/x.jpg')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('resolve');
  });
});

describe('GET /api/image — upstream hardening', () => {
  it('rejects upstream 302 redirect (prevents SSRF via redirect chain)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://cdn.example.com/image.jpg')}`,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('UPSTREAM_REDIRECT');
    // Verify redirect:'manual' was requested so fetch did not follow.
    expect(mockFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/image.jpg',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects non-image Content-Type (e.g. HTML from a misconfigured origin)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('<html>not an image</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://cdn.example.com/page.html')}`,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('NOT_AN_IMAGE');
  });

  it('outputs WebP when input has an alpha channel (preserves logo transparency)', async () => {
    mockSharpMetadata.mockResolvedValueOnce({ hasAlpha: true, format: 'png' });
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
      }),
    );

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://cdn.example.com/logo.png')}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
  });

  it('outputs JPEG when input has no alpha channel (default path)', async () => {
    // mockSharpMetadata defaults to hasAlpha:false in beforeEach
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4' },
      }),
    );

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://cdn.example.com/card.jpg')}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('private mode disables public caching for sensitive images', async () => {
    mockFetch.mockResolvedValueOnce(fakeImageResponse());

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://cdn.example.com/card.jpg')}&mode=private`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
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

    const res = await app.request(
      `/api/image?url=${encodeURIComponent('https://cdn.example.com/huge.jpg')}`,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('IMAGE_TOO_LARGE');
  });
});
