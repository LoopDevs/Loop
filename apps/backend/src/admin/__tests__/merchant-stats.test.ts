import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  orders: {
    merchantId: 'orders.merchant_id',
    currency: 'orders.currency',
    state: 'orders.state',
    fulfilledAt: 'orders.fulfilled_at',
    faceValueMinor: 'orders.face_value_minor',
    wholesaleMinor: 'orders.wholesale_minor',
    userCashbackMinor: 'orders.user_cashback_minor',
    loopMarginMinor: 'orders.loop_margin_minor',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminMerchantStatsHandler } from '../merchant-stats.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
});

describe('adminMerchantStatsHandler', () => {
  it('returns empty rows when there are no fulfilled orders in the window', async () => {
    const res = await adminMerchantStatsHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; since: string };
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('normalises bigint + Date + string shapes', async () => {
    state.rows = [
      {
        merchant_id: 'argos',
        currency: 'GBP',
        order_count: '3',
        face_value_minor: 15_000n,
        wholesale_minor: '12000',
        user_cashback_minor: 1800,
        loop_margin_minor: 1200n,
        last_fulfilled_at: new Date('2026-04-20T10:00:00Z'),
      },
      {
        merchant_id: 'tesco',
        currency: 'GBP',
        order_count: 1,
        face_value_minor: '5000',
        wholesale_minor: '4000',
        user_cashback_minor: '600',
        loop_margin_minor: '400',
        last_fulfilled_at: '2026-04-18T14:00:00Z',
      },
    ];
    const res = await adminMerchantStatsHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      merchantId: 'argos',
      currency: 'GBP',
      orderCount: 3,
      faceValueMinor: '15000',
      wholesaleMinor: '12000',
      userCashbackMinor: '1800',
      loopMarginMinor: '1200',
      lastFulfilledAt: '2026-04-20T10:00:00.000Z',
    });
    expect(body.rows[1]!['lastFulfilledAt']).toBe('2026-04-18T14:00:00.000Z');
  });

  it('echoes since as ISO in the response', async () => {
    const res = await adminMerchantStatsHandler(makeCtx({ since: '2026-03-10T00:00:00Z' }));
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-03-10T00:00:00.000Z');
  });

  it('400 on malformed since', async () => {
    const res = await adminMerchantStatsHandler(makeCtx({ since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminMerchantStatsHandler(makeCtx({ since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('tolerates { rows } envelope from pg driver', async () => {
    state.rows = {
      rows: [
        {
          merchant_id: 'amazon',
          currency: 'USD',
          order_count: 2,
          face_value_minor: '20000',
          wholesale_minor: '16000',
          user_cashback_minor: '2400',
          loop_margin_minor: '1600',
          last_fulfilled_at: new Date('2026-04-19T00:00:00Z'),
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await adminMerchantStatsHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['merchantId']).toBe('amazon');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantStatsHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
