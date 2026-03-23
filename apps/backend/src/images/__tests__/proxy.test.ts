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

// Mock sharp — native module, not needed for URL validation tests
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      info: { width: 100, height: 100 },
    }),
  })),
}));

import { app } from '../../app.js';

// Mock global fetch for upstream image fetches
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
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
});
