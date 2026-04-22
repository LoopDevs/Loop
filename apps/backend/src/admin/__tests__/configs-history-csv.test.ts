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
      changedAt: Date;
      merchantId: string;
      wholesalePct: string;
      userCashbackPct: string;
      loopMarginPct: string;
      active: boolean;
      changedBy: string;
    }>,
    throw: false,
  },
  merchantState: { byId: new Map<string, { name: string }>() },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
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
  merchantCashbackConfigHistory: {
    merchantId: 'merchant_id',
    changedAt: 'changed_at',
  },
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: vi.fn(() => ({ merchantsById: merchantState.byId })),
}));

import { adminConfigsHistoryCsvHandler } from '../configs-history-csv.js';

function makeCtx(): Context {
  return {
    req: {},
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
  merchantState.byId = new Map();
});

describe('adminConfigsHistoryCsvHandler', () => {
  it('emits newest-first CSV with header + attachment + private cache headers', async () => {
    dbState.rows = [
      {
        id: 'h-1',
        changedAt: new Date('2026-04-21T10:00:00Z'),
        merchantId: 'm-amazon',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        changedBy: 'admin-1',
      },
    ];
    merchantState.byId = new Map([['m-amazon', { name: 'Amazon' }]]);
    const res = await adminConfigsHistoryCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="loop-cashback-configs-history.csv"',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'History ID,Changed at (UTC),Merchant ID,Merchant name,Wholesale %,User cashback %,Loop margin %,Active,Changed by',
    );
    expect(lines[1]).toBe(
      'h-1,2026-04-21T10:00:00.000Z,m-amazon,Amazon,70.00,25.00,5.00,true,admin-1',
    );
  });

  it('falls back to merchantId when the catalog has evicted the row', async () => {
    dbState.rows = [
      {
        id: 'h-ghost',
        changedAt: new Date('2026-04-20T00:00:00Z'),
        merchantId: 'm-ghost',
        wholesalePct: '80.00',
        userCashbackPct: '15.00',
        loopMarginPct: '5.00',
        active: false,
        changedBy: 'admin-2',
      },
    ];
    const res = await adminConfigsHistoryCsvHandler(makeCtx());
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[1]).toContain(',m-ghost,m-ghost,');
    expect(lines[1]).toContain(',false,');
  });

  it('RFC-4180-escapes merchant names with commas / quotes', async () => {
    dbState.rows = [
      {
        id: 'h-x',
        changedAt: new Date('2026-04-20T00:00:00Z'),
        merchantId: 'm-x',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        changedBy: 'admin',
      },
    ];
    merchantState.byId = new Map([['m-x', { name: 'Acme, "The" Inc.' }]]);
    const res = await adminConfigsHistoryCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"Acme, ""The"" Inc."');
  });

  it('emits only the header when there is no history', async () => {
    dbState.rows = [];
    const res = await adminConfigsHistoryCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.trim().split('\r\n')).toHaveLength(1);
  });

  it('500 when the db read throws', async () => {
    dbState.throw = true;
    const res = await adminConfigsHistoryCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
