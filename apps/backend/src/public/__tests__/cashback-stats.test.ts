import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  users: 0,
  fulfilled: 0,
  cashback: [] as Array<{ currency: string; amount_minor: string | bigint | number }>,
  throwOn: null as 'users' | 'orders' | 'cashback' | null,
}));

function classify(q: string): 'users' | 'orders' | 'cashback' {
  if (q.includes("state = 'fulfilled'")) return 'orders';
  if (q.includes('COUNT(DISTINCT user_id)')) return 'users';
  return 'cashback';
}

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      // drizzle sql`` template literals pass through as an object with
      // a .queryChunks / .values; easier to stringify and pattern match.
      const stringified = JSON.stringify(query);
      const kind = classify(stringified);
      state.calls.push(kind);
      if (state.throwOn === kind) throw new Error(`db exploded on ${kind}`);
      if (kind === 'users') return [{ n: state.users.toString() }];
      if (kind === 'orders') return [{ n: state.fulfilled.toString() }];
      return state.cashback;
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    // Stringify sql template so the mock can classify the query.
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({
        __sql: true,
        queryChunks: strings.raw,
        values,
      }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { publicCashbackStatsHandler, __resetPublicCashbackStatsCache } from '../cashback-stats.js';

function makeCtx(): Context {
  const headers = new Map<string, string>();
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: Object.assign(
          { 'content-type': 'application/json' },
          Object.fromEntries(headers.entries()),
        ),
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.calls = [];
  state.users = 0;
  state.fulfilled = 0;
  state.cashback = [];
  state.throwOn = null;
  __resetPublicCashbackStatsCache();
});

describe('publicCashbackStatsHandler', () => {
  it('returns zeros on a fresh DB with no credit_transactions', async () => {
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      totalUsersWithCashback: 0,
      fulfilledOrders: 0,
      totalCashbackByCurrency: [],
    });
    expect(typeof body['asOf']).toBe('string');
  });

  it('serialises bigint + number aggregates and groups by currency', async () => {
    state.users = 1234;
    state.fulfilled = 5678;
    state.cashback = [
      { currency: 'GBP', amount_minor: 9_000_000n },
      { currency: 'USD', amount_minor: '4500000' },
      { currency: 'EUR', amount_minor: 1_200_000 },
    ];
    const res = await publicCashbackStatsHandler(makeCtx());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalUsersWithCashback']).toBe(1234);
    expect(body['fulfilledOrders']).toBe(5678);
    expect(body['totalCashbackByCurrency']).toEqual([
      { currency: 'GBP', amountMinor: '9000000' },
      { currency: 'USD', amountMinor: '4500000' },
      { currency: 'EUR', amountMinor: '1200000' },
    ]);
  });

  it('never 500s — DB throws serve zeros on bootstrap with max-age=60', async () => {
    state.throwOn = 'users';
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalUsersWithCashback']).toBe(0);
    expect(body['totalCashbackByCurrency']).toEqual([]);
  });

  it('serves last-known-good on DB failure after a successful run', async () => {
    state.users = 42;
    state.fulfilled = 17;
    state.cashback = [{ currency: 'GBP', amount_minor: 999n }];
    const first = await publicCashbackStatsHandler(makeCtx());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody['totalUsersWithCashback']).toBe(42);

    state.throwOn = 'cashback';
    const second = await publicCashbackStatsHandler(makeCtx());
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('public, max-age=60');
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody['totalUsersWithCashback']).toBe(42);
    expect(secondBody['fulfilledOrders']).toBe(17);
  });

  it('emits cache-control: public, max-age=300 on the happy path', async () => {
    const res = await publicCashbackStatsHandler(makeCtx());
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });
});
