import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState, merchantState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as Array<{ merchantId: string; userCashbackPct: string; active: boolean }>,
    throw: false,
  },
  merchantState: {
    byId: new Map<string, { name: string; logoUrl?: string }>(),
  },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn(() => leaf),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async () => {
      if (dbState.throw) throw new Error('db exploded');
      return dbState.rows;
    }),
  };
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => leaf) })),
    },
  };
});
vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: {
    merchantId: 'merchant_id',
    active: 'active',
    userCashbackPct: 'user_cashback_pct',
  },
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: vi.fn(() => ({ merchantsById: merchantState.byId })),
}));

import { topCashbackMerchantsHandler } from '../top-cashback-merchants.js';

function makeCtx(query: Record<string, string> = {}): Context {
  const headers = new Headers();
  return {
    req: { query: (k: string) => query[k] },
    header: (name: string, value: string) => headers.set(name, value),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...Object.fromEntries(headers) },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  dbState.rows = [];
  dbState.throw = false;
  merchantState.byId = new Map();
});

describe('topCashbackMerchantsHandler', () => {
  it('happy path — returns merchants joined to catalog with logo + Cache-Control', async () => {
    dbState.rows = [
      { merchantId: 'm-amazon', userCashbackPct: '18.00', active: true },
      { merchantId: 'm-asos', userCashbackPct: '14.00', active: true },
    ];
    merchantState.byId = new Map([
      ['m-amazon', { name: 'Amazon', logoUrl: 'https://cdn/amazon.png' }],
      ['m-asos', { name: 'ASOS' }],
    ]);
    const res = await topCashbackMerchantsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await res.json()) as {
      merchants: Array<Record<string, unknown>>;
    };
    expect(body.merchants).toHaveLength(2);
    expect(body.merchants[0]).toEqual({
      merchantId: 'm-amazon',
      merchantName: 'Amazon',
      logoUrl: 'https://cdn/amazon.png',
      userCashbackPct: '18.00',
    });
    // logoUrl omitted (not included) when the catalog entry has none.
    expect(body.merchants[1]).toEqual({
      merchantId: 'm-asos',
      merchantName: 'ASOS',
      userCashbackPct: '14.00',
    });
  });

  it('drops rows whose merchant is not in the catalog (marketing surface)', async () => {
    dbState.rows = [
      { merchantId: 'm-evicted', userCashbackPct: '20.00', active: true },
      { merchantId: 'm-kept', userCashbackPct: '10.00', active: true },
    ];
    merchantState.byId = new Map([['m-kept', { name: 'Kept' }]]);
    const res = await topCashbackMerchantsHandler(makeCtx());
    const body = (await res.json()) as { merchants: Array<{ merchantId: string }> };
    expect(body.merchants).toHaveLength(1);
    expect(body.merchants[0]?.merchantId).toBe('m-kept');
  });

  it('respects ?limit after catalog filtering (overshoots then truncates)', async () => {
    dbState.rows = Array.from({ length: 30 }, (_, i) => ({
      merchantId: `m-${i}`,
      userCashbackPct: '10.00',
      active: true,
    }));
    merchantState.byId = new Map(
      Array.from({ length: 30 }, (_, i) => [`m-${i}`, { name: `Merchant ${i}` }]),
    );
    const res = await topCashbackMerchantsHandler(makeCtx({ limit: '5' }));
    const body = (await res.json()) as { merchants: unknown[] };
    expect(body.merchants).toHaveLength(5);
  });

  it('clamps malformed / huge / zero ?limit values', async () => {
    dbState.rows = [];
    for (const limit of ['9999', 'nope', '0', '-5']) {
      const res = await topCashbackMerchantsHandler(makeCtx({ limit }));
      expect(res.status).toBe(200);
    }
  });

  it('returns empty list when there are no active cashback configs', async () => {
    dbState.rows = [];
    const res = await topCashbackMerchantsHandler(makeCtx());
    const body = (await res.json()) as { merchants: unknown[] };
    expect(body.merchants).toEqual([]);
  });

  it('500 when the db read throws', async () => {
    dbState.throw = true;
    const res = await topCashbackMerchantsHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
