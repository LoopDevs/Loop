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
    },
  };
});
vi.mock('../../db/schema.js', () => ({
  orders: {
    userId: 'user_id',
    state: 'state',
    createdAt: 'created_at',
  },
}));

import { adminListOrdersHandler } from '../orders.js';

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
