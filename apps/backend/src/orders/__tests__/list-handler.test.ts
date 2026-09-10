// GET /api/orders list-handler tests — AUD-08
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

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
      userId: 'victim-account',
      status: "fulfilled' OR 1=1",
      perPage: '999999',
    });
    await listOrdersHandler(ctx);

    for (const url of upstreamCallUrls()) {
      expect(url.searchParams.get('perPage')).toBe('100');
      expect(url.searchParams.get('page')).toBeTruthy();
      expect(url.searchParams.has('userId')).toBe(false);
      expect(url.searchParams.has('status')).toBe(false);
      expect(url.searchParams.has('excludePending')).toBe(false);
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
    status: 'unpaid',
  });
  const doneRow = (id: string, status = 'fulfilled'): UpstreamItem => ({
    id,
    merchantId: 'm',
    merchantName: 'Shop',
    cardFiatAmount: '25.00',
    cardFiatCurrency: 'USD',
    status,
  });

  it('an all-pending first upstream page does NOT produce a false-empty page', async () => {
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
    // Response bodies are single-read; each list request re-walks upstream pages.
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
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.status).toBe('pending');
    expect(body.pagination).toMatchObject({ total: 42, totalPages: 3, hasNext: true });
  });
});
