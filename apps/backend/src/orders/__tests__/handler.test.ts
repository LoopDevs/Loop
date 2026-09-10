import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      ctx: { ...actual.config.ctx, baseUrl: 'http://test-upstream.local' },
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

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

vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

const mockNotifyOrderCreated = vi.fn();
const mockNotifyOrderFulfilled = vi.fn();
vi.mock('../../discord.js', () => ({
  notifyOrderCreated: (...args: unknown[]) => mockNotifyOrderCreated(...args),
  notifyOrderFulfilled: (...args: unknown[]) => mockNotifyOrderFulfilled(...args),
  notifyHealthChange: vi.fn(),
  notifyCtxSchemaDrift: vi.fn(),
}));

import { app, __resetRateLimitsForTests } from '../../app.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const AUTH_HEADER = { Authorization: 'Bearer test-token' };

beforeEach(() => {
  mockFetch.mockReset();
  mockNotifyOrderCreated.mockReset();
  mockNotifyOrderFulfilled.mockReset();
  // In-memory rate limiter persists across requests; reset to prevent 429s in burst tests
  __resetRateLimitsForTests();
  mockGetMerchants.mockReturnValue({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
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
    expect(body.order.status).toBe('completed');
    expect(body.order.amount).toBe(10);
    expect(body.order.currency).toBe('USD');
    expect(body.order.redeemUrl).toBe(
      'https://spend.ctx.com/gift-cards/88ab206f-abc/redeem?token=xyz',
    );
    expect(body.order.redeemChallengeCode).toBe('WCBENDRJXR');
    expect(body.order.createdAt).toBe('2026-03-25T18:08:58Z');
  });

  it('fires notifyOrderFulfilled once on the first fulfilled observation', async () => {
    const upstreamResponse = {
      id: 'fulfil-once-1',
      merchantId: 'm-42',
      merchantName: 'Aerie',
      cardFiatAmount: '10.00',
      cardFiatCurrency: 'USD',
      paymentCryptoAmount: '55.27',
      status: 'fulfilled',
      redeemType: 'url',
      created: '2026-03-25T18:08:58Z',
    };
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(upstreamResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(upstreamResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(upstreamResponse), { status: 200 }));

    await app.request('/api/orders/fulfil-once-1', { headers: AUTH_HEADER });
    await app.request('/api/orders/fulfil-once-1', { headers: AUTH_HEADER });
    await app.request('/api/orders/fulfil-once-1', { headers: AUTH_HEADER });

    expect(mockNotifyOrderFulfilled).toHaveBeenCalledTimes(1);
    expect(mockNotifyOrderFulfilled).toHaveBeenCalledWith({
      orderId: 'fulfil-once-1',
      merchantId: 'Aerie',
      faceValueMinor: 1000n,
      currency: 'USD',
    });
  });

  it('does not fire notifyOrderFulfilled for pending/unpaid orders', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'pending-1',
          merchantId: 'm-42',
          merchantName: 'Aerie',
          cardFiatAmount: '10.00',
          cardFiatCurrency: 'USD',
          status: 'unpaid',
          created: '2026-03-25T18:08:58Z',
        }),
        { status: 200 },
      ),
    );

    await app.request('/api/orders/pending-1', { headers: AUTH_HEADER });

    expect(mockNotifyOrderFulfilled).not.toHaveBeenCalled();
  });
});

describe('GET /api/orders', () => {
  it('passes query params to upstream', async () => {
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

  it('returns Cache-Control: private, no-store to keep user-specific data out of shared caches', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pagination: { page: 1, pages: 1, perPage: 20, total: 0 },
          result: [],
        }),
        { status: 200 },
      ),
    );
    const res = await app.request('/api/orders', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('sets Cache-Control even on the 401 requireAuth emits without a bearer', async () => {
    const res = await app.request('/api/orders');
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
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
    expect(body.orders[0]!.status).toBe('completed');
    expect(body.orders[0]!.amount).toBe(25);
    expect(body.orders[0]!.createdAt).toBe('2026-03-25T18:08:58Z');
    expect(body.orders[1]!.status).toBe('pending');

    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(10);
    expect(body.pagination.total).toBe(25);
    expect(body.pagination.totalPages).toBe(3);
    expect(body.pagination.hasNext).toBe(true);
    expect(body.pagination.hasPrev).toBe(false);
  });

  it('returns 502 when upstream response has unexpected shape', async () => {
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
