import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env before any other imports
vi.mock('../../env.js', () => ({
  env: {
    PORT: '8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
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

// Mock circuit breaker to pass through to global fetch (avoids cross-test state leaks)
vi.mock('../../circuit-breaker.js', () => {
  class CircuitOpenError extends Error {
    constructor() {
      super('Circuit breaker is open — upstream service unavailable');
      this.name = 'CircuitOpenError';
    }
  }
  return {
    CircuitOpenError,
    getAllCircuitStates: () => ({}),
    getUpstreamCircuit: () => ({
      fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
      getState: () => 'closed' as const,
      reset: () => {},
    }),
  };
});

import { app } from '../../app.js';

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

  it('forwards X-Client-Id header to upstream', async () => {
    // Put merchant in cache
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test' }],
      merchantsById: new Map([
        ['m-1', { id: 'm-1', name: 'Test', denominations: { currency: 'USD' } }],
      ]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });

    // Mock successful upstream response
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'order-1',
          paymentCryptoAmount: '1.0',
          paymentUrls: { XLM: 'web+stellar:pay?destination=GXXX&amount=1.0&memo=test' },
          status: 'unpaid',
        }),
        { status: 200 },
      ),
    );

    await app.request('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
        'X-Client-Id': 'loopweb',
      },
      body: JSON.stringify({ merchantId: 'm-1', amount: 10 }),
    });

    // Verify X-Client-Id was forwarded to upstream
    const fetchCall = mockFetch.mock.calls[0]!;
    const fetchInit = fetchCall[1] as RequestInit;
    const headers = fetchInit.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toBe('loopweb');
  });

  it('returns 201 with mapped data on success', async () => {
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test Store', denominations: { currency: 'USD' } }],
      merchantsById: new Map([
        ['m-1', { id: 'm-1', name: 'Test Store', denominations: { currency: 'USD' } }],
      ]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });

    // Real CTX upstream response shape
    const upstreamResponse = {
      id: '372a9846-abc',
      merchantId: 'm-1',
      merchantName: 'Test Store',
      cardFiatAmount: '25.00',
      cardFiatCurrency: 'USD',
      paymentCryptoAmount: '100.5',
      paymentCryptoCurrency: 'XLM',
      paymentCryptoChain: 'XLM',
      paymentUrls: {
        XLM: 'web+stellar:pay?destination=GABCDEF1234567890&amount=100.5&memo=ctx%3Amtz6lwWw',
      },
      status: 'unpaid',
      paymentStatus: 'unpaid',
      fulfilmentStatus: 'pending',
      percentDiscount: '2.00',
      rate: '0.1773',
      created: '2026-03-25T18:30:00Z',
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
    expect(body.orderId).toBe('372a9846-abc');
    expect(body.paymentAddress).toBe('GABCDEF1234567890');
    expect(body.xlmAmount).toBe('100.5');
    expect(body.paymentUri).toBe(
      'web+stellar:pay?destination=GABCDEF1234567890&amount=100.5&memo=ctx%3Amtz6lwWw',
    );
    expect(body.memo).toBe('ctx:mtz6lwWw');
    // Server-authoritative payment window: unix seconds now + ORDER_EXPIRY_SECONDS (30min).
    const nowSec = Math.floor(Date.now() / 1000);
    expect(typeof body.expiresAt).toBe('number');
    const expiresAt = body.expiresAt as number;
    expect(expiresAt).toBeGreaterThanOrEqual(nowSec + 29 * 60);
    expect(expiresAt).toBeLessThanOrEqual(nowSec + 31 * 60);
  });

  it('returns 502 when upstream creates an order but omits the XLM payment URL', async () => {
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test Store', denominations: { currency: 'USD' } }],
      merchantsById: new Map([
        ['m-1', { id: 'm-1', name: 'Test Store', denominations: { currency: 'USD' } }],
      ]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });

    // Upstream returns a valid-shape response but without XLM in paymentUrls.
    // The client can't pay an order with no URI; surface as 502 instead of
    // returning a broken 201 that sets up a useless payment screen.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'no-xlm-order',
          paymentCryptoAmount: '100',
          paymentUrls: { BTC: 'bitcoin:abc' },
          status: 'unpaid',
        }),
        { status: 200 },
      ),
    );

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ merchantId: 'm-1', amount: 25 }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UPSTREAM_ERROR');
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

  it('returns mapped order with status and redemption fields', async () => {
    const upstreamResponse = {
      id: '88ab206f-abc',
      merchantId: 'a8f90501-xyz',
      merchantName: 'Aerie',
      cardFiatAmount: '10.00',
      cardFiatCurrency: 'USD',
      paymentCryptoAmount: '55.2735680',
      status: 'fulfilled',
      paymentStatus: 'paid',
      fulfilmentStatus: 'complete',
      redeemType: 'url',
      redeemUrl: 'https://spend.ctx.com/gift-cards/88ab206f-abc/redeem?token=xyz',
      redeemUrlChallenge: 'WCBENDRJXR',
      created: '2026-03-25T18:08:58Z',
      updated: '2026-03-25T18:09:12Z',
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200 }),
    );

    const res = await app.request('/api/orders/88ab206f-abc', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: Record<string, unknown> };
    expect(body.order.id).toBe('88ab206f-abc');
    expect(body.order.status).toBe('completed'); // fulfilled → completed
    expect(body.order.amount).toBe(10);
    expect(body.order.currency).toBe('USD');
    expect(body.order.redeemUrl).toBe(
      'https://spend.ctx.com/gift-cards/88ab206f-abc/redeem?token=xyz',
    );
    expect(body.order.redeemChallengeCode).toBe('WCBENDRJXR'); // mapped from redeemUrlChallenge
    expect(body.order.createdAt).toBe('2026-03-25T18:08:58Z');
  });
});

describe('GET /api/orders', () => {
  it('passes query params to upstream', async () => {
    // Real CTX list response shape
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 2, pages: 27, perPage: 10, total: 265 },
          result: [],
        }),
        { status: 200 },
      ),
    );

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

  it('maps upstream list response to our format', async () => {
    const upstreamResponse = {
      pagination: { page: 1, pages: 3, perPage: 10, total: 25 },
      result: [
        {
          id: 'order-1',
          merchantId: 'm-1',
          merchantName: 'Aerie',
          cardFiatAmount: '25.00',
          cardFiatCurrency: 'USD',
          paymentCryptoAmount: '138.18',
          status: 'fulfilled',
          fulfilmentStatus: 'complete',
          redeemType: 'url',
          created: '2026-03-25T18:08:58Z',
        },
        {
          id: 'order-2',
          merchantId: 'm-2',
          merchantName: 'Target',
          cardFiatAmount: '50.00',
          cardFiatCurrency: 'USD',
          paymentCryptoAmount: '276.36',
          status: 'unpaid',
          fulfilmentStatus: 'pending',
          created: '2026-03-25T18:30:00Z',
        },
      ],
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200 }),
    );

    const res = await app.request('/api/orders', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };

    expect(body.orders).toHaveLength(2);
    expect(body.orders[0]!.id).toBe('order-1');
    expect(body.orders[0]!.status).toBe('completed'); // fulfilled → completed
    expect(body.orders[0]!.amount).toBe(25);
    expect(body.orders[0]!.createdAt).toBe('2026-03-25T18:08:58Z');
    expect(body.orders[1]!.status).toBe('pending'); // unpaid → pending

    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(10);
    expect(body.pagination.total).toBe(25);
    expect(body.pagination.totalPages).toBe(3);
    expect(body.pagination.hasNext).toBe(true);
    expect(body.pagination.hasPrev).toBe(false);
  });

  it('returns 502 when upstream response has unexpected shape', async () => {
    // Missing result and pagination
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ orders: [] }), { status: 200 }));

    const res = await app.request('/api/orders', {
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('UPSTREAM_ERROR');
  });

  it('strips unknown query params before forwarding to upstream (no param injection)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: [],
          pagination: { page: 1, pages: 1, perPage: 10, total: 0 },
        }),
        { status: 200 },
      ),
    );

    // Attacker appends userId=other-user. Must not reach upstream.
    await app.request('/api/orders?page=1&perPage=10&userId=victim&customField=evil', {
      headers: AUTH_HEADER,
    });

    const [urlString] = mockFetch.mock.calls[0] as [string];
    const forwarded = new URL(urlString);
    expect(forwarded.searchParams.get('page')).toBe('1');
    expect(forwarded.searchParams.get('perPage')).toBe('10');
    expect(forwarded.searchParams.has('userId')).toBe(false);
    expect(forwarded.searchParams.has('customField')).toBe(false);
  });
});

describe('POST /api/orders — amount validation', () => {
  beforeEach(() => {
    mockGetMerchants.mockReturnValue({
      merchants: [{ id: 'm-1', name: 'Test', denominations: { currency: 'USD' } }],
      merchantsById: new Map([
        ['m-1', { id: 'm-1', name: 'Test', denominations: { currency: 'USD' } }],
      ]),
      merchantsBySlug: new Map(),
      loadedAt: Date.now(),
    });
  });

  function postOrder(body: unknown): Promise<Response> | Response {
    return app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify(body),
    });
  }

  it('rejects amount below $0.01', async () => {
    const res = await postOrder({ merchantId: 'm-1', amount: 0.005 });
    expect(res.status).toBe(400);
  });

  it('rejects amount above $10,000', async () => {
    const res = await postOrder({ merchantId: 'm-1', amount: 10_001 });
    expect(res.status).toBe(400);
  });

  it('rejects Infinity', async () => {
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      // JSON.stringify(Infinity) === 'null', so send raw JSON.
      body: '{"merchantId":"m-1","amount":1e500}',
    });
    expect(res.status).toBe(400);
  });

  it('rejects sub-cent precision (fractional pennies)', async () => {
    const res = await postOrder({ merchantId: 'm-1', amount: 10.555 });
    expect(res.status).toBe(400);
  });

  it('sends fiatAmount as two-decimal string to upstream (no IEEE-754 leak)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'o1',
          paymentCryptoAmount: '1.0',
          paymentUrls: { XLM: 'web+stellar:pay?destination=G1&amount=1.0&memo=x' },
          status: 'unpaid',
        }),
        { status: 200 },
      ),
    );

    // 0.1 + 0.2 === 0.30000000000000004 — .multipleOf rejects, so use a clean value
    // that still tests the toFixed branch: 25 serializes as 25, toFixed(2) → "25.00".
    await postOrder({ merchantId: 'm-1', amount: 25 });

    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(init.body as string) as { fiatAmount: string };
    expect(sent.fiatAmount).toBe('25.00');
  });
});
