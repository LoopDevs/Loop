import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Drizzle select-chain mock: `.select().from().where().orderBy().limit()`.
 * Tests push rows into `state.rows` and the chain's terminal `.limit`
 * resolves to whichever slice the handler asked for. The handler uses
 * either `.from(t).orderBy().limit()` (no filter) or `.from(t).where().
 * orderBy().limit()` (with filter) — so both paths share the same leaf
 * and the `.where` call is recorded into `state.whereCalls` for
 * assertions.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    whereCalls: [] as unknown[],
    limitCalls: [] as number[],
    throwOnLimit: false,
    executeRows: [] as unknown[],
    throwOnExecute: false,
  },
}));
vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn((cond: unknown) => {
      dbState.whereCalls.push(cond);
      return leaf;
    }),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async (n: number) => {
      dbState.limitCalls.push(n);
      if (dbState.throwOnLimit) throw new Error('db exploded');
      return dbState.rows;
    }),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => leaf),
      })),
      execute: vi.fn(async () => {
        if (dbState.throwOnExecute) throw new Error('db exploded');
        return dbState.executeRows;
      }),
    },
  };
});
vi.mock('../../db/schema.js', () => ({
  orders: {
    userId: 'user_id',
    state: 'state',
    createdAt: 'created_at',
    chargeCurrency: 'charge_currency',
    faceValueMinor: 'face_value_minor',
    chargeMinor: 'charge_minor',
    userCashbackMinor: 'user_cashback_minor',
    loopMarginMinor: 'loop_margin_minor',
  },
}));

import { adminListOrdersHandler, adminOrdersSummaryHandler } from '../orders.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function makeRow(
  overrides: Partial<{
    id: string;
    userId: string;
    merchantId: string;
    state: string;
    currency: string;
    faceValueMinor: bigint;
    chargeCurrency: string;
    chargeMinor: bigint;
    paymentMethod: string;
    wholesalePct: string;
    userCashbackPct: string;
    loopMarginPct: string;
    wholesaleMinor: bigint;
    userCashbackMinor: bigint;
    loopMarginMinor: bigint;
    ctxOrderId: string | null;
    ctxOperatorId: string | null;
    failureReason: string | null;
    createdAt: Date;
    paidAt: Date | null;
    procuredAt: Date | null;
    fulfilledAt: Date | null;
    failedAt: Date | null;
  }> = {},
): Record<string, unknown> {
  return {
    id: 'o-1',
    userId: 'u-1',
    merchantId: 'm-1',
    state: 'paid',
    currency: 'USD',
    faceValueMinor: 5000n,
    chargeCurrency: 'GBP',
    chargeMinor: 4000n,
    paymentMethod: 'loop_asset',
    wholesalePct: '80.00',
    userCashbackPct: '15.00',
    loopMarginPct: '5.00',
    wholesaleMinor: 3200n,
    userCashbackMinor: 600n,
    loopMarginMinor: 200n,
    ctxOrderId: null,
    ctxOperatorId: null,
    failureReason: null,
    createdAt: new Date('2026-04-20T12:00:00Z'),
    paidAt: new Date('2026-04-20T12:05:00Z'),
    procuredAt: null,
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.rows = [];
  dbState.whereCalls = [];
  dbState.limitCalls = [];
  dbState.throwOnLimit = false;
  dbState.executeRows = [];
  dbState.throwOnExecute = false;
});

describe('adminListOrdersHandler', () => {
  it('happy path — returns admin-shaped rows with bigint-as-string fields', async () => {
    dbState.rows = [makeRow()];
    const res = await adminListOrdersHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<Record<string, unknown>>;
    };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      id: 'o-1',
      userId: 'u-1',
      merchantId: 'm-1',
      state: 'paid',
      faceValueMinor: '5000',
      chargeMinor: '4000',
      wholesaleMinor: '3200',
      userCashbackMinor: '600',
      loopMarginMinor: '200',
      wholesalePct: '80.00',
      userCashbackPct: '15.00',
      loopMarginPct: '5.00',
      paymentMethod: 'loop_asset',
      ctxOrderId: null,
      createdAt: '2026-04-20T12:00:00.000Z',
      paidAt: '2026-04-20T12:05:00.000Z',
      procuredAt: null,
    });
  });

  it('returns an empty list when no orders match', async () => {
    dbState.rows = [];
    const res = await adminListOrdersHandler(makeCtx());
    const body = (await res.json()) as { orders: unknown[] };
    expect(body.orders).toEqual([]);
  });

  it('rejects an unknown ?state with 400', async () => {
    const res = await adminListOrdersHandler(makeCtx({ state: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('accepts a valid ?state filter', async () => {
    dbState.rows = [makeRow({ state: 'failed' })];
    const res = await adminListOrdersHandler(makeCtx({ state: 'failed' }));
    expect(res.status).toBe(200);
    // WHERE predicate was built — exactly one filter.
    expect(dbState.whereCalls).toHaveLength(1);
  });

  it('rejects a non-UUID ?userId with 400', async () => {
    const res = await adminListOrdersHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('accepts a valid UUID ?userId filter', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    dbState.rows = [makeRow({ userId: uuid })];
    const res = await adminListOrdersHandler(makeCtx({ userId: uuid }));
    expect(res.status).toBe(200);
    expect(dbState.whereCalls).toHaveLength(1);
  });

  it('rejects an invalid ?before timestamp with 400', async () => {
    const res = await adminListOrdersHandler(makeCtx({ before: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('clamps ?limit — huge values cap at 100, malformed falls back to default', async () => {
    await adminListOrdersHandler(makeCtx({ limit: '9999' }));
    expect(dbState.limitCalls[0]).toBe(100);
    dbState.limitCalls = [];
    await adminListOrdersHandler(makeCtx({ limit: 'nope' }));
    expect(dbState.limitCalls[0]).toBe(20);
  });

  it('stacks state + userId + before into a single WHERE', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await adminListOrdersHandler(
      makeCtx({ state: 'paid', userId: uuid, before: '2026-04-20T12:00:00Z' }),
    );
    expect(dbState.whereCalls).toHaveLength(1);
  });

  it('500s when the db read throws', async () => {
    dbState.throwOnLimit = true;
    const res = await adminListOrdersHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});

describe('adminOrdersSummaryHandler', () => {
  it('happy path — rolls state counts, fulfilled totals, outstanding totals', async () => {
    dbState.executeRows = [
      {
        state: 'fulfilled',
        chargeCurrency: 'GBP',
        n: 3,
        faceSum: 15000n,
        chargeSum: 12000n,
        cashbackSum: 1800n,
        marginSum: 600n,
      },
      {
        state: 'fulfilled',
        chargeCurrency: 'USD',
        n: 1,
        faceSum: 5000n,
        chargeSum: 4000n,
        cashbackSum: 600n,
        marginSum: 200n,
      },
      {
        state: 'paid',
        chargeCurrency: 'GBP',
        n: 2,
        faceSum: 0n,
        chargeSum: 8000n,
        cashbackSum: 0n,
        marginSum: 0n,
      },
      {
        state: 'procuring',
        chargeCurrency: 'GBP',
        n: 1,
        faceSum: 0n,
        chargeSum: 4000n,
        cashbackSum: 0n,
        marginSum: 0n,
      },
      {
        state: 'failed',
        chargeCurrency: 'USD',
        n: 2,
        faceSum: 0n,
        chargeSum: 0n,
        cashbackSum: 0n,
        marginSum: 0n,
      },
    ];
    const res = await adminOrdersSummaryHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      fulfilledTotals: Record<string, Record<string, unknown>>;
      outstandingTotals: Record<string, Record<string, unknown>>;
    };
    expect(body.counts).toEqual({
      pending_payment: 0,
      paid: 2,
      procuring: 1,
      fulfilled: 4,
      failed: 2,
      expired: 0,
    });
    expect(body.fulfilledTotals.GBP).toEqual({
      orderCount: 3,
      faceMinor: '15000',
      chargeMinor: '12000',
      userCashbackMinor: '1800',
      loopMarginMinor: '600',
    });
    expect(body.fulfilledTotals.USD).toEqual({
      orderCount: 1,
      faceMinor: '5000',
      chargeMinor: '4000',
      userCashbackMinor: '600',
      loopMarginMinor: '200',
    });
    // Paid (8000) + procuring (4000) fold together into GBP outstanding.
    expect(body.outstandingTotals.GBP).toEqual({ orderCount: 3, chargeMinor: '12000' });
    expect(body.outstandingTotals.USD).toBeUndefined();
  });

  it('returns zeroed counts + empty totals when the table is empty', async () => {
    dbState.executeRows = [];
    const res = await adminOrdersSummaryHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      fulfilledTotals: Record<string, unknown>;
      outstandingTotals: Record<string, unknown>;
    };
    expect(body.counts.fulfilled).toBe(0);
    expect(body.counts.paid).toBe(0);
    expect(body.fulfilledTotals).toEqual({});
    expect(body.outstandingTotals).toEqual({});
  });

  it('handles the {rows: [...]} result shape from drizzle', async () => {
    // Some drizzle drivers return { rows: [...] } instead of a raw array.
    dbState.executeRows = {
      rows: [
        {
          state: 'fulfilled',
          chargeCurrency: 'EUR',
          n: 1,
          faceSum: 1000n,
          chargeSum: 800n,
          cashbackSum: 120n,
          marginSum: 40n,
        },
      ],
    } as unknown as unknown[];
    const res = await adminOrdersSummaryHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      fulfilledTotals: Record<string, Record<string, unknown>>;
    };
    expect(body.counts.fulfilled).toBe(1);
    expect(body.fulfilledTotals.EUR).toMatchObject({
      orderCount: 1,
      chargeMinor: '800',
    });
  });

  it('ignores unknown state values rather than crashing', async () => {
    dbState.executeRows = [
      {
        state: 'mystery',
        chargeCurrency: 'GBP',
        n: 99,
        faceSum: 0n,
        chargeSum: 0n,
        cashbackSum: 0n,
        marginSum: 0n,
      },
    ];
    const res = await adminOrdersSummaryHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number> };
    expect(Object.values(body.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('500s when the db read throws', async () => {
    dbState.throwOnExecute = true;
    const res = await adminOrdersSummaryHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
