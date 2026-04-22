import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  lastLimit: 0,
}));

const limitMock = vi.fn(async (n: number) => {
  state.lastLimit = n;
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  orders: {
    id: 'orders.id',
    userId: 'orders.user_id',
    merchantId: 'orders.merchant_id',
    state: 'orders.state',
    createdAt: 'orders.created_at',
    paidAt: 'orders.paid_at',
    procuredAt: 'orders.procured_at',
    ctxOrderId: 'orders.ctx_order_id',
    ctxOperatorId: 'orders.ctx_operator_id',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    asc: (col: unknown) => ({ __asc: true, col }),
    inArray: (col: unknown, values: unknown) => ({ __inArray: true, col, values }),
    lt: (col: unknown, value: unknown) => ({ __lt: true, col, value }),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminStuckOrdersHandler } from '../stuck-orders.js';

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
  state.lastLimit = 0;
  limitMock.mockClear();
  orderByMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminStuckOrdersHandler', () => {
  it('returns empty rows with the default threshold when nothing is stuck', async () => {
    const res = await adminStuckOrdersHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thresholdMinutes: number; rows: unknown[] };
    expect(body.thresholdMinutes).toBe(5);
    expect(body.rows).toEqual([]);
  });

  it('computes ageMinutes from paidAt for state=paid rows', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    state.rows = [
      {
        id: 'o-1',
        userId: 'u-1',
        merchantId: 'm-1',
        state: 'paid',
        createdAt: new Date(Date.now() - 15 * 60_000),
        paidAt: tenMinAgo,
        procuredAt: null,
        ctxOrderId: null,
        ctxOperatorId: null,
      },
    ];
    const res = await adminStuckOrdersHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['state']).toBe('paid');
    expect(body.rows[0]!['stuckSince']).toBe(tenMinAgo.toISOString());
    // Allow a 1-minute jitter for test-clock slippage.
    expect(body.rows[0]!['ageMinutes']).toBeGreaterThanOrEqual(9);
    expect(body.rows[0]!['ageMinutes']).toBeLessThanOrEqual(11);
  });

  it('computes ageMinutes from procuredAt for state=procuring rows', async () => {
    const eightMinAgo = new Date(Date.now() - 8 * 60_000);
    state.rows = [
      {
        id: 'o-2',
        userId: 'u-2',
        merchantId: 'm-2',
        state: 'procuring',
        createdAt: new Date(Date.now() - 20 * 60_000),
        paidAt: new Date(Date.now() - 15 * 60_000),
        procuredAt: eightMinAgo,
        ctxOrderId: 'ctx-1',
        ctxOperatorId: 'op-1',
      },
    ];
    const res = await adminStuckOrdersHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows[0]!['state']).toBe('procuring');
    expect(body.rows[0]!['stuckSince']).toBe(eightMinAgo.toISOString());
  });

  it('falls back to paidAt → createdAt when the state-specific timestamp is null', async () => {
    const twelveMinAgo = new Date(Date.now() - 12 * 60_000);
    state.rows = [
      {
        id: 'o-3',
        userId: 'u-3',
        merchantId: 'm-3',
        state: 'procuring',
        createdAt: twelveMinAgo,
        paidAt: null, // unusual but handled
        procuredAt: null,
        ctxOrderId: null,
        ctxOperatorId: null,
      },
    ];
    const res = await adminStuckOrdersHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows[0]!['stuckSince']).toBe(twelveMinAgo.toISOString());
  });

  it('clamps thresholdMinutes — huge values cap at a week, bad values fall back to 5', async () => {
    const resBad = await adminStuckOrdersHandler(makeCtx({ thresholdMinutes: 'nope' }));
    const bad = (await resBad.json()) as { thresholdMinutes: number };
    expect(bad.thresholdMinutes).toBe(5);

    const resHuge = await adminStuckOrdersHandler(makeCtx({ thresholdMinutes: '999999' }));
    const huge = (await resHuge.json()) as { thresholdMinutes: number };
    expect(huge.thresholdMinutes).toBe(10_080);

    const resZero = await adminStuckOrdersHandler(makeCtx({ thresholdMinutes: '0' }));
    const zero = (await resZero.json()) as { thresholdMinutes: number };
    expect(zero.thresholdMinutes).toBe(1);
  });

  it('clamps limit 1..100, defaults 20', async () => {
    await adminStuckOrdersHandler(makeCtx());
    expect(state.lastLimit).toBe(20);
    await adminStuckOrdersHandler(makeCtx({ limit: '500' }));
    expect(state.lastLimit).toBe(100);
    await adminStuckOrdersHandler(makeCtx({ limit: '0' }));
    expect(state.lastLimit).toBe(1);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminStuckOrdersHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
