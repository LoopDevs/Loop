import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState, merchantState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as Array<{
      id: string;
      merchantId: string;
      wholesalePct: string;
      userCashbackPct: string;
      loopMarginPct: string;
      active: boolean;
      changedBy: string;
      changedAt: Date;
    }>,
    throw: false,
    lastLimit: undefined as number | undefined,
  },
  merchantState: { byId: new Map<string, { name: string }>() },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async (n: number) => {
      dbState.lastLimit = n;
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
  merchantCashbackConfigHistory: {
    merchantId: 'merchant_id',
    changedAt: 'changed_at',
  },
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: vi.fn(() => ({ merchantsById: merchantState.byId })),
}));

import { adminConfigsRecentHistoryHandler } from '../configs-recent-history.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: { query: (k: string) => query[k] },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  dbState.rows = [];
  dbState.throw = false;
  dbState.lastLimit = undefined;
  merchantState.byId = new Map();
});

describe('adminConfigsRecentHistoryHandler', () => {
  it('happy path — enriches rows with merchant name, defaults limit to 50', async () => {
    dbState.rows = [
      {
        id: 'h-1',
        merchantId: 'm-amazon',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        changedBy: 'admin-1',
        changedAt: new Date('2026-04-21T09:00:00Z'),
      },
    ];
    merchantState.byId = new Map([['m-amazon', { name: 'Amazon' }]]);
    const res = await adminConfigsRecentHistoryHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(dbState.lastLimit).toBe(50);
    const body = (await res.json()) as {
      history: Array<Record<string, unknown>>;
    };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]).toEqual({
      id: 'h-1',
      merchantId: 'm-amazon',
      merchantName: 'Amazon',
      wholesalePct: '70.00',
      userCashbackPct: '25.00',
      loopMarginPct: '5.00',
      active: true,
      changedBy: 'admin-1',
      changedAt: '2026-04-21T09:00:00.000Z',
    });
  });

  it('falls back to merchantId when the catalog has evicted the row', async () => {
    dbState.rows = [
      {
        id: 'h-2',
        merchantId: 'm-ghost',
        wholesalePct: '80.00',
        userCashbackPct: '15.00',
        loopMarginPct: '5.00',
        active: false,
        changedBy: 'admin-2',
        changedAt: new Date('2026-04-21T10:00:00Z'),
      },
    ];
    const res = await adminConfigsRecentHistoryHandler(makeCtx());
    const body = (await res.json()) as { history: Array<{ merchantName: string }> };
    expect(body.history[0]?.merchantName).toBe('m-ghost');
  });

  it('clamps ?limit — huge values cap at 200, malformed falls back to default', async () => {
    dbState.rows = [];
    await adminConfigsRecentHistoryHandler(makeCtx({ limit: '9999' }));
    expect(dbState.lastLimit).toBe(200);
    await adminConfigsRecentHistoryHandler(makeCtx({ limit: 'nope' }));
    expect(dbState.lastLimit).toBe(50);
    await adminConfigsRecentHistoryHandler(makeCtx({ limit: '0' }));
    expect(dbState.lastLimit).toBe(1);
  });

  it('returns empty list when there is no history', async () => {
    dbState.rows = [];
    const res = await adminConfigsRecentHistoryHandler(makeCtx());
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history).toEqual([]);
  });

  it('500 when the db read throws', async () => {
    dbState.throw = true;
    const res = await adminConfigsRecentHistoryHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
