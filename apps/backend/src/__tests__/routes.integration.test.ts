import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock server to prevent port binding
vi.mock('@hono/node-server', () => ({ serve: vi.fn() }));

// Mock env before any other imports
vi.mock('../env.js', () => ({
  env: {
    PORT: '8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    GIFT_CARD_API_KEY: 'test-key',
    GIFT_CARD_API_SECRET: 'test-secret',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
  },
}));

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock background refresh to prevent timers and network calls
vi.mock('../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
}));

vi.mock('../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

// Mock image proxy eviction
vi.mock('../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

// Mock clustering handler to avoid proto import
vi.mock('../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

import { app } from '../index.js';

// Mock global fetch for upstream proxy calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GET /health', () => {
  it('returns 200 with status healthy when upstream is reachable', async () => {
    // Mock the upstream /status probe
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('locationCount');
    expect(body).toHaveProperty('merchantCount');
    expect(body).toHaveProperty('upstreamReachable');
    expect(body.upstreamReachable).toBe(true);
  });

  it('returns degraded when upstream is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.upstreamReachable).toBe(false);
  });
});

describe('GET /api/merchants', () => {
  it('returns 200 with empty merchant list', async () => {
    const res = await app.request('/api/merchants');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('merchants');
    expect(Array.isArray(body.merchants)).toBe(true);
  });
});

describe('GET /api/merchants/by-slug/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    const res = await app.request('/api/merchants/by-slug/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/merchants/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/merchants/unknown-id');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/request-otp', () => {
  it('returns 400 for missing email', async () => {
    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 200 when upstream accepts the login request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'ok' }), { status: 200 }),
    );

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-upstream.local/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns 502 when upstream rejects the login request', async () => {
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/auth/verify-otp', () => {
  it('returns 400 for missing fields', async () => {
    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns tokens when upstream verifies successfully', async () => {
    const tokens = { accessToken: 'at-123', refreshToken: 'rt-456' };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens), { status: 200 }));

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', otp: '123456' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accessToken).toBe('at-123');
    expect(body.refreshToken).toBe('rt-456');
  });

  it('returns 401 when upstream rejects the code', async () => {
    mockFetch.mockResolvedValueOnce(new Response('invalid', { status: 401 }));

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', otp: '000000' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('returns 400 for missing refresh token', async () => {
    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns new tokens when upstream accepts refresh', async () => {
    const tokens = { accessToken: 'new-at' };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens), { status: 200 }));

    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'rt-valid' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accessToken).toBe('new-at');
  });
});

describe('GET /api/orders', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/api/orders');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/orders', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/clusters', () => {
  it('returns 200 for cluster requests', async () => {
    const res = await app.request('/api/clusters?west=-100&south=30&east=-90&north=40&zoom=5');
    expect(res.status).toBe(200);
  });
});
