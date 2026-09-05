/**
 * Unit tests for the admin CTX operator-commission proxy
 * (`admin/ctx-commission.ts`, ctx-interop).
 *
 * Covers the behaviours that matter:
 *   - the company id is EVALUATED, not configured: resolved from CTX
 *     `GET /me` under the API creds and cached per process (second
 *     request must not re-fetch /me);
 *   - the happy path fans out to both commission endpoints with the
 *     operator API-key headers and maps the responses onto the shared
 *     type (extra CTX fields dropped, passthrough tolerated);
 *   - upstream non-2xx (including /me) → 502 UPSTREAM_ERROR;
 *   - upstream schema drift → 502 UPSTREAM_ERROR (logged, not thrown).
 */
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const mockEnv = vi.hoisted(
  () =>
    ({
      GIFT_CARD_API_KEY: 'op-key',
      GIFT_CARD_API_SECRET: 'op-secret',
    }) as Record<string, unknown>,
);
vi.mock('../../env.js', () => ({ env: mockEnv }));

vi.mock('../../upstream.js', () => ({
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

import { adminCtxCommissionHandler, resetCtxCompanyIdCache } from '../ctx-commission.js';

const meBody = { company: { id: 'loop-co-1', name: 'Loop' }, user: { id: 'api-user' } };

const commissionBody = {
  companyId: 'loop-co-1',
  balances: [{ currency: 'USD', amount: '12.34', entryCount: 3, extraCtxField: true }],
  lastSettlementAt: '2026-08-20T00:00:00Z',
};

const settlementsBody = {
  pagination: { page: 1, pages: 1, perPage: 10, total: 1 },
  result: [
    {
      id: 'settle-1',
      amount: '40.00',
      currency: 'USD',
      periodStart: '2026-08-01T00:00:00Z',
      periodEnd: '2026-08-19T00:00:00Z',
      giftCardIds: ['gc-1', 'gc-2'],
      entryIds: ['e-1', 'e-2'],
      entryCount: 2,
      created: '2026-08-19T00:05:00Z',
    },
  ],
};

// NOT `ReturnType<typeof vi.spyOn>` — that erases the fetch-specific
// generics and turns `.mock.calls` into any[].
function mockCtxFetch(): MockInstance<typeof globalThis.fetch> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith('/me')) {
      return Promise.resolve(new Response(JSON.stringify(meBody), { status: 200 }));
    }
    if (url.includes('/commission/settlements')) {
      return Promise.resolve(new Response(JSON.stringify(settlementsBody), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(commissionBody), { status: 200 }));
  });
}

function makeApp(): Hono {
  const app = new Hono();
  app.get('/api/admin/ctx-commission', adminCtxCommissionHandler);
  return app;
}

describe('adminCtxCommissionHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCtxCompanyIdCache();
    mockEnv['GIFT_CARD_API_KEY'] = 'op-key';
    mockEnv['GIFT_CARD_API_SECRET'] = 'op-secret';
  });

  it('resolves the company id from /me and proxies balances + settlements with API-key headers', async () => {
    const fetchSpy = mockCtxFetch();

    const res = await makeApp().request('/api/admin/ctx-commission');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['configured']).toBe(true);
    expect(body['companyId']).toBe('loop-co-1');
    expect(body['balances']).toEqual([{ currency: 'USD', amount: '12.34', entryCount: 3 }]);
    expect(body['lastSettlementAt']).toBe('2026-08-20T00:00:00Z');
    expect(body['settlements']).toEqual([
      {
        id: 'settle-1',
        amount: '40.00',
        currency: 'USD',
        periodStart: '2026-08-01T00:00:00Z',
        periodEnd: '2026-08-19T00:00:00Z',
        giftCardIds: ['gc-1', 'gc-2'],
        entryCount: 2,
        created: '2026-08-19T00:05:00Z',
      },
    ]);

    const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('http://ctx.test/me');
    expect(urls.some((u) => u.includes('/companies/loop-co-1/commission'))).toBe(true);
    for (const call of fetchSpy.mock.calls) {
      const headers = ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers['X-Api-Key']).toBe('op-key');
      expect(headers['X-Api-Secret']).toBe('op-secret');
    }
  });

  it('caches the resolved company id across requests', async () => {
    const fetchSpy = mockCtxFetch();
    const app = makeApp();

    await app.request('/api/admin/ctx-commission');
    await app.request('/api/admin/ctx-commission');

    const meCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).endsWith('/me'));
    expect(meCalls).toHaveLength(1);
  });

  it('maps a failing /me to 502 UPSTREAM_ERROR and retries on the next request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('denied', { status: 401 }));

    const res = await makeApp().request('/api/admin/ctx-commission');

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('UPSTREAM_ERROR');

    fetchSpy.mockRestore();
    mockCtxFetch();
    const retry = await makeApp().request('/api/admin/ctx-commission');
    expect(retry.status).toBe(200);
  });

  it('maps upstream schema drift to 502 UPSTREAM_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return Promise.resolve(new Response(JSON.stringify(meBody), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ nonsense: true }), { status: 200 }));
    });

    const res = await makeApp().request('/api/admin/ctx-commission');

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('UPSTREAM_ERROR');
  });
});
