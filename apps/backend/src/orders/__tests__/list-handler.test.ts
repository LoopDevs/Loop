/**
 * `GET /api/orders` list-handler tests (AUD-08).
 *
 * Two things under test:
 *
 *   1. The injection-sensitive forward-to-CTX allowlist. Only
 *      CTX-native params (`page`/`perPage`/`status`) may reach the
 *      upstream; everything else — including the new Loop-side
 *      `excludePending` control and any injected `userId` — must be
 *      stripped. These assertions are the security gate: a widening
 *      of the allowlist (or a bug forwarding client strings during
 *      exclude-pending aggregation) turns them red.
 *
 *   2. Exclude-pending server-side pagination. The handler must walk
 *      the upstream pages, drop rows whose translated Loop status is
 *      `pending`, and serve a STABLE, COMPLETE page of the filtered
 *      set — no false-empty page, no hidden pages. This is the
 *      AUD-08 root-cause fix; it is red on the pre-AUD-08 handler,
 *      which ignored `excludePending`, made a single upstream call
 *      for the client\'s page, and returned pending rows unfiltered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../env.js', () => ({
  env: { GIFT_CARD_API_BASE_URL: 'http://test-upstream.local' },
}));

vi.mock('../../circuit-breaker.js', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {},
  getUpstreamCircuit: () => ({
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  }),
}));

const { notifyCtxSchemaDrift } = vi.hoisted(() => ({ notifyCtxSchemaDrift: vi.fn() }));
vi.mock('../../discord.js', () => ({ notifyCtxSchemaDrift }));

import { listOrdersHandler } from '../list-handler.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  notifyCtxSchemaDrift.mockReset();
});

function makeCtx(query: Record<string, string>): Context {
  const store = new Map<string, unknown>([['bearerToken', 'test-bearer']]);
  return {
    req: { query: () => query },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function upstreamResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface UpstreamItem {
  id: string;
  merchantId: string;
  merchantName?: string;
  cardFiatAmount?: string;
  cardFiatCurrency?: string;
  status?: string;
}

function upstreamPage(
  page: number,
  pages: number,
  result: UpstreamItem[],
): ReturnType<typeof upstreamResponse> {
  return upstreamResponse({
    pagination: { page, pages, perPage: 100, total: pages * 100 },
    result,
  });
}

/** All URLs the handler pushed to the upstream, as parsed URL objects. */
function upstreamCallUrls(): URL[] {
  return mockFetch.mock.calls.map((call) => new URL(call[0] as string));
}

describe('listOrdersHandler — injection-safe allowlist (AUD-08)', () => {
  it('plain-proxy path forwards ONLY page/perPage/status; strips injected params', async () => {
    mockFetch.mockResolvedValueOnce(upstreamPage(2, 2, []));

    const ctx = makeCtx({
      page: '2',
      perPage: '10',
      status: 'fulfilled',
      // Injection attempts — an upstream-only param a naive CTX might
      // honour to read another account, plus SQL/scope noise.
      userId: 'victim-account',
      accountId: 'victim-account',
      role: 'admin',
      'status[]': 'x',
      "status'; DROP TABLE orders;--": '1',
    });
    await listOrdersHandler(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = upstreamCallUrls()[0]!;
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('perPage')).toBe('10');
    expect(url.searchParams.get('status')).toBe('fulfilled');
    // Nothing outside the CTX-native allowlist may reach the upstream.
    for (const forbidden of [
      'userId',
      'accountId',
      'role',
      'status[]',
      'excludePending',
      "status'; DROP TABLE orders;--",
    ]) {
      expect(url.searchParams.has(forbidden)).toBe(false);
    }
  });

  it('exclude-pending path never forwards a client string to CTX — only server page/perPage', async () => {
    mockFetch.mockResolvedValueOnce(upstreamPage(1, 1, []));

    const ctx = makeCtx({
      excludePending: 'true',
      page: '1',
      // These must NOT reach CTX during aggregation.
      userId: 'victim-account',
      status: "fulfilled' OR 1=1",
      perPage: '999999',
    });
    await listOrdersHandler(ctx);

    for (const url of upstreamCallUrls()) {
      // Server-constructed pagination only.
      expect(url.searchParams.get('perPage')).toBe('100');
      expect(url.searchParams.get('page')).toBeTruthy();
      // No client-controlled value may appear on the upstream URL.
      expect(url.searchParams.has('userId')).toBe(false);
      expect(url.searchParams.has('status')).toBe(false);
      expect(url.searchParams.has('excludePending')).toBe(false);
      // The client\'s bogus perPage must never override the server value.
      expect(url.searchParams.get('perPage')).not.toBe('999999');
    }
  });
});

describe('listOrdersHandler — exclude-pending server-side pagination (AUD-08)', () => {
  const pendingRow = (id: string): UpstreamItem => ({
    id,
    merchantId: 'm',
    merchantName: 'Shop',
    cardFiatAmount: '10.00',
    cardFiatCurrency: 'USD',
    status: 'unpaid', // maps to Loop `pending`
  });
  const doneRow = (id: string, status = 'fulfilled'): UpstreamItem => ({
    id,
    merchantId: 'm',
    merchantName: 'Shop',
    cardFiatAmount: '25.00',
    cardFiatCurrency: 'USD',
    status, // fulfilled→completed, refunded→failed, expired→expired
  });

  it('an all-pending first upstream page does NOT produce a false-empty page', async () => {
    // Upstream page 1 is entirely pending; the caller\'s completed
    // orders live on page 2. The pre-AUD-08 handler returned page 1
    // as-is (empty after the client dropped pending) and could hide
    // Prev/Next — the trap. Now the backend walks to page 2 and
    // serves the non-pending rows on Loop page 1.
    mockFetch
      .mockResolvedValueOnce(upstreamPage(1, 2, [pendingRow('p1'), pendingRow('p2')]))
      .mockResolvedValueOnce(
        upstreamPage(2, 2, [doneRow('d1'), doneRow('d2', 'refunded'), pendingRow('p3')]),
      );

    const ctx = makeCtx({ excludePending: 'true', page: '1' });
    const res = await listOrdersHandler(ctx);
    const body = (await res.json()) as {
      orders: { id: string; status: string }[];
      pagination: { total: number; hasNext: boolean; hasPrev: boolean };
    };

    expect(body.orders.map((o) => o.id)).toEqual(['d1', 'd2']);
    expect(body.orders.every((o) => o.status !== 'pending')).toBe(true);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.hasNext).toBe(false);
    expect(body.pagination.hasPrev).toBe(false);
  });

  it('paginates the FILTERED set with stable, complete pages', async () => {
    // 3 non-pending orders interleaved with pending across 2 upstream
    // pages; Loop perPage=2. Page 1 = first two filtered rows + Next;
    // page 2 = the third filtered row + Prev, no Next. No row is lost
    // or duplicated across the boundary.
    // Build a FRESH Response per call — a Response body can only be
    // read once, and each list request re-walks every upstream page.
    const pageData: [number, number, UpstreamItem[]][] = [
      [1, 2, [doneRow('a'), pendingRow('p1'), doneRow('b')]],
      [2, 2, [pendingRow('p2'), doneRow('c')]],
    ];
    mockFetch.mockImplementation(async (url: string) => {
      const requested = Number(new URL(url).searchParams.get('page'));
      const spec = pageData.find(([p]) => p === requested)!;
      return upstreamPage(spec[0], spec[1], spec[2]);
    });

    const page1 = (await (
      await listOrdersHandler(makeCtx({ excludePending: 'true', page: '1', perPage: '2' }))
    ).json()) as {
      orders: { id: string }[];
      pagination: { total: number; totalPages: number; hasNext: boolean; hasPrev: boolean };
    };
    expect(page1.orders.map((o) => o.id)).toEqual(['a', 'b']);
    expect(page1.pagination).toMatchObject({
      total: 3,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });

    mockFetch.mockClear();
    const page2 = (await (
      await listOrdersHandler(makeCtx({ excludePending: 'true', page: '2', perPage: '2' }))
    ).json()) as {
      orders: { id: string }[];
      pagination: { hasNext: boolean; hasPrev: boolean };
    };
    expect(page2.orders.map((o) => o.id)).toEqual(['c']);
    expect(page2.pagination).toMatchObject({ hasNext: false, hasPrev: true });
  });

  it('propagates an upstream failure encountered mid-walk', async () => {
    mockFetch
      .mockResolvedValueOnce(upstreamPage(1, 2, [pendingRow('p1')]))
      .mockResolvedValueOnce(new Response('nope', { status: 502 }));

    const res = await listOrdersHandler(makeCtx({ excludePending: 'true', page: '1' }));
    expect(res.status).toBe(502);
  });
});

describe('listOrdersHandler — plain-proxy path unchanged', () => {
  it('passes upstream pagination straight through when excludePending is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      upstreamResponse({
        pagination: { page: 1, pages: 3, perPage: 20, total: 42 },
        result: [
          {
            id: 'o1',
            merchantId: 'm',
            merchantName: 'Shop',
            cardFiatAmount: '10.00',
            cardFiatCurrency: 'USD',
            status: 'unpaid',
          },
        ],
      }),
    );

    const res = await listOrdersHandler(makeCtx({ page: '1' }));
    const body = (await res.json()) as {
      orders: { id: string; status: string }[];
      pagination: { total: number; totalPages: number; hasNext: boolean };
    };

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Plain proxy does NOT filter — the pending row is passed through.
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.status).toBe('pending');
    expect(body.pagination).toMatchObject({ total: 42, totalPages: 3, hasNext: true });
  });
});
