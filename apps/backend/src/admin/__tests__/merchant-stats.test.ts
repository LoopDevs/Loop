import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { execState, merchantState } = vi.hoisted(() => ({
  execState: { rows: [] as unknown[] | { rows: unknown[] }, throw: false },
  merchantState: { byId: new Map<string, { name: string }>() },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (execState.throw) throw new Error('db exploded');
      return execState.rows;
    }),
  },
}));
vi.mock('../../db/schema.js', () => ({
  orders: {
    merchantId: 'merchant_id',
    state: 'state',
    chargeCurrency: 'charge_currency',
    faceValueMinor: 'face_value_minor',
    chargeMinor: 'charge_minor',
    userCashbackMinor: 'user_cashback_minor',
    loopMarginMinor: 'loop_margin_minor',
    wholesaleMinor: 'wholesale_minor',
    fulfilledAt: 'fulfilled_at',
  },
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: vi.fn(() => ({ merchantsById: merchantState.byId })),
}));

import { adminMerchantStatsHandler } from '../merchant-stats.js';

function makeCtx(params: Record<string, string> = {}, query: Record<string, string> = {}): Context {
  return {
    req: {
      param: (k: string) => params[k],
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  execState.rows = [];
  execState.throw = false;
  merchantState.byId = new Map<string, { name: string }>();
});

describe('adminMerchantStatsHandler', () => {
  it('400 when merchantId param is missing', async () => {
    const res = await adminMerchantStatsHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('happy path — aggregates across currencies + resolves merchant name', async () => {
    merchantState.byId = new Map([['m-amazon', { name: 'Amazon' }]]);
    execState.rows = [
      {
        chargeCurrency: 'GBP',
        n: 5,
        faceSum: 25000n,
        chargeSum: 20000n,
        cashbackSum: 3000n,
        marginSum: 1000n,
        wholesaleSum: 16000n,
        lastFulfilled: new Date('2026-04-20T09:00:00Z'),
      },
      {
        chargeCurrency: 'USD',
        n: 2,
        faceSum: 10000n,
        chargeSum: 8000n,
        cashbackSum: 1200n,
        marginSum: 400n,
        wholesaleSum: 6400n,
        lastFulfilled: new Date('2026-04-21T15:00:00Z'),
      },
    ];
    const res = await adminMerchantStatsHandler(makeCtx({ merchantId: 'm-amazon' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      merchantName: string;
      fulfilled: Record<string, Record<string, unknown>>;
      lastFulfilledAt: string | null;
    };
    expect(body.merchantName).toBe('Amazon');
    expect(body.fulfilled.GBP).toEqual({
      orderCount: 5,
      faceMinor: '25000',
      chargeMinor: '20000',
      userCashbackMinor: '3000',
      loopMarginMinor: '1000',
      wholesaleMinor: '16000',
    });
    expect(body.fulfilled.USD?.orderCount).toBe(2);
    // lastFulfilledAt is the max across all currencies.
    expect(body.lastFulfilledAt).toBe('2026-04-21T15:00:00.000Z');
  });

  it('falls back to merchantId when the catalog has evicted the row', async () => {
    execState.rows = [
      {
        chargeCurrency: 'GBP',
        n: 1,
        faceSum: 1000n,
        chargeSum: 800n,
        cashbackSum: 120n,
        marginSum: 40n,
        wholesaleSum: 640n,
        lastFulfilled: new Date('2026-04-20T09:00:00Z'),
      },
    ];
    const res = await adminMerchantStatsHandler(makeCtx({ merchantId: 'm-ghost' }));
    const body = (await res.json()) as { merchantName: string };
    expect(body.merchantName).toBe('m-ghost');
  });

  it('returns empty fulfilled + null lastFulfilledAt when there are no fulfilled orders', async () => {
    merchantState.byId = new Map([['m-new', { name: 'NewCo' }]]);
    execState.rows = [];
    const res = await adminMerchantStatsHandler(makeCtx({ merchantId: 'm-new' }));
    const body = (await res.json()) as {
      fulfilled: Record<string, unknown>;
      lastFulfilledAt: string | null;
    };
    expect(body.fulfilled).toEqual({});
    expect(body.lastFulfilledAt).toBeNull();
  });

  it('handles ISO-string lastFulfilled values (non-Date-coercing drivers)', async () => {
    execState.rows = [
      {
        chargeCurrency: 'EUR',
        n: 1,
        faceSum: 100n,
        chargeSum: 80n,
        cashbackSum: 12n,
        marginSum: 4n,
        wholesaleSum: 64n,
        lastFulfilled: '2026-04-20T09:00:00Z',
      },
    ];
    const res = await adminMerchantStatsHandler(makeCtx({ merchantId: 'm-x' }));
    const body = (await res.json()) as { lastFulfilledAt: string | null };
    expect(body.lastFulfilledAt).toBe('2026-04-20T09:00:00.000Z');
  });

  it('handles the {rows: [...]} drizzle result shape', async () => {
    execState.rows = {
      rows: [
        {
          chargeCurrency: 'GBP',
          n: 1,
          faceSum: 500n,
          chargeSum: 400n,
          cashbackSum: 60n,
          marginSum: 20n,
          wholesaleSum: 320n,
          lastFulfilled: new Date('2026-04-20T09:00:00Z'),
        },
      ],
    };
    const res = await adminMerchantStatsHandler(makeCtx({ merchantId: 'm-x' }));
    const body = (await res.json()) as { fulfilled: Record<string, Record<string, unknown>> };
    expect(body.fulfilled.GBP?.orderCount).toBe(1);
  });

  it('500 when the db read throws', async () => {
    execState.throw = true;
    const res = await adminMerchantStatsHandler(makeCtx({ merchantId: 'm-x' }));
    expect(res.status).toBe(500);
  });
});
