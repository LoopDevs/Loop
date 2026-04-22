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
  pendingPayouts: {
    id: 'pending_payouts.id',
    userId: 'pending_payouts.user_id',
    orderId: 'pending_payouts.order_id',
    assetCode: 'pending_payouts.asset_code',
    amountStroops: 'pending_payouts.amount_stroops',
    state: 'pending_payouts.state',
    attempts: 'pending_payouts.attempts',
    createdAt: 'pending_payouts.created_at',
    submittedAt: 'pending_payouts.submitted_at',
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

import { adminStuckPayoutsHandler } from '../stuck-payouts.js';

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

describe('adminStuckPayoutsHandler', () => {
  it('returns empty rows with the default threshold when nothing is stuck', async () => {
    const res = await adminStuckPayoutsHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { thresholdMinutes: number; rows: unknown[] };
    expect(body.thresholdMinutes).toBe(5);
    expect(body.rows).toEqual([]);
  });

  it('computes ageMinutes from submittedAt for state=submitted rows', async () => {
    const sevenMinAgo = new Date(Date.now() - 7 * 60_000);
    state.rows = [
      {
        id: 'p-1',
        userId: 'u-1',
        orderId: 'o-1',
        assetCode: 'GBPLOOP',
        amountStroops: 50_000_000n,
        state: 'submitted',
        attempts: 1,
        createdAt: new Date(Date.now() - 12 * 60_000),
        submittedAt: sevenMinAgo,
      },
    ];
    const res = await adminStuckPayoutsHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['state']).toBe('submitted');
    expect(body.rows[0]!['stuckSince']).toBe(sevenMinAgo.toISOString());
    expect(body.rows[0]!['amountStroops']).toBe('50000000');
    // 1-minute jitter for test-clock slippage.
    expect(body.rows[0]!['ageMinutes']).toBeGreaterThanOrEqual(6);
    expect(body.rows[0]!['ageMinutes']).toBeLessThanOrEqual(8);
  });

  it('computes ageMinutes from createdAt for state=pending rows', async () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60_000);
    state.rows = [
      {
        id: 'p-2',
        userId: 'u-2',
        orderId: 'o-2',
        assetCode: 'USDLOOP',
        amountStroops: 12_000_000n,
        state: 'pending',
        attempts: 0,
        createdAt: sixMinAgo,
        submittedAt: null,
      },
    ];
    const res = await adminStuckPayoutsHandler(makeCtx());
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows[0]!['state']).toBe('pending');
    expect(body.rows[0]!['stuckSince']).toBe(sixMinAgo.toISOString());
  });

  it('falls back to createdAt when a submitted row has a null submittedAt', async () => {
    const nineMinAgo = new Date(Date.now() - 9 * 60_000);
    state.rows = [
      {
        id: 'p-3',
        userId: 'u-3',
        orderId: 'o-3',
        assetCode: 'EURLOOP',
        amountStroops: 1n,
        state: 'submitted',
        attempts: 1,
        createdAt: nineMinAgo,
        submittedAt: null, // unusual but handled
      },
    ];
    const res = await adminStuckPayoutsHandler(makeCtx());
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]!['stuckSince']).toBe(nineMinAgo.toISOString());
  });

  it('clamps thresholdMinutes — huge values cap at a week, bad values fall back to 5', async () => {
    const resBad = await adminStuckPayoutsHandler(makeCtx({ thresholdMinutes: 'nope' }));
    const bad = (await resBad.json()) as { thresholdMinutes: number };
    expect(bad.thresholdMinutes).toBe(5);

    const resHuge = await adminStuckPayoutsHandler(makeCtx({ thresholdMinutes: '999999' }));
    const huge = (await resHuge.json()) as { thresholdMinutes: number };
    expect(huge.thresholdMinutes).toBe(10_080);

    const resZero = await adminStuckPayoutsHandler(makeCtx({ thresholdMinutes: '0' }));
    const zero = (await resZero.json()) as { thresholdMinutes: number };
    expect(zero.thresholdMinutes).toBe(1);
  });

  it('clamps limit 1..100, defaults 20', async () => {
    await adminStuckPayoutsHandler(makeCtx());
    expect(state.lastLimit).toBe(20);
    await adminStuckPayoutsHandler(makeCtx({ limit: '500' }));
    expect(state.lastLimit).toBe(100);
    await adminStuckPayoutsHandler(makeCtx({ limit: '0' }));
    expect(state.lastLimit).toBe(1);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminStuckPayoutsHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
