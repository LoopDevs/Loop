import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock server to prevent port binding
vi.mock('@hono/node-server', () => ({ serve: vi.fn() }));

// Mock env before any other imports
vi.mock('../../env.js', () => ({
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
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock background refresh to prevent timers and network calls
vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
}));

const mockGetMerchants = vi.fn(
  (): Record<string, unknown> => ({
    merchants: [],
    merchantsById: new Map<string, unknown>(),
    merchantsBySlug: new Map<string, unknown>(),
    loadedAt: Date.now(),
  }),
);

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => mockGetMerchants(),
}));

// Mock image proxy eviction
vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

// Mock clustering handler to avoid proto import
vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

import { app } from '../../index.js';

// Mock global fetch for upstream proxy calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

beforeEach(() => {
  mockFetch.mockReset();
  mockGetMerchants.mockReturnValue({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  });
});

describe('POST /api/orders', () => {
  it('returns 404 when merchant is not in cache', async () => {
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ merchantId: 'nonexistent-merchant', amount: 25 }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 502 when upstream returns unexpected JSON shape', async () => {
    // Put the merchant in cache so it passes the lookup
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test Store' }],
      merchantsById: new Map([['m-1', { id: 'm-1', name: 'Test Store' }]]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });

    // Upstream returns 200 but with a bad shape (missing required fields)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }),
    );

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ merchantId: 'm-1', amount: 50 }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UPSTREAM_ERROR');
  });

  it('returns 401 when upstream rejects bearer token', async () => {
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test Store' }],
      merchantsById: new Map([['m-1', { id: 'm-1', name: 'Test Store' }]]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });

    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ merchantId: 'm-1', amount: 25 }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 201 with validated data on success', async () => {
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test Store', denominations: { currency: 'USD' } }],
      merchantsById: new Map([
        ['m-1', { id: 'm-1', name: 'Test Store', denominations: { currency: 'USD' } }],
      ]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });

    const upstreamResponse = {
      orderId: 'order-abc',
      paymentAddress: 'GABCDEF1234567890',
      xlmAmount: '100.5',
      expiresAt: 1700000000,
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200 }),
    );

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ merchantId: 'm-1', amount: 25 }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.orderId).toBe('order-abc');
    expect(body.paymentAddress).toBe('GABCDEF1234567890');
    expect(body.xlmAmount).toBe('100.5');
    expect(body.expiresAt).toBe(1700000000);
  });
});

describe('GET /api/orders/:id', () => {
  it('returns 400 for invalid order ID (path traversal attempt)', async () => {
    const res = await app.request('/api/orders/..%2Ffoo', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 502 when upstream returns unexpected shape', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ garbage: true }), { status: 200 }),
    );

    const res = await app.request('/api/orders/valid-order-id', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UPSTREAM_ERROR');
  });
});

describe('GET /api/orders', () => {
  it('passes query params to upstream', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ orders: [] }), { status: 200 }));

    const res = await app.request('/api/orders?page=2&status=completed', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('status')).toBe('completed');
  });
});
