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
      merchantId: string;
      wholesalePct: string;
      userCashbackPct: string;
      loopMarginPct: string;
      active: boolean;
      updatedBy: string;
      updatedAt: Date;
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
  merchantCashbackConfigs: { merchantId: 'merchant_id' },
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: vi.fn(() => ({ merchantsById: merchantState.byId })),
}));

import { adminConfigsCsvHandler } from '../configs-csv.js';

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

describe('adminConfigsCsvHandler', () => {
  it('emits CSV with header + rows, attachment headers, private cache', async () => {
    dbState.rows = [
      {
        merchantId: 'm-amazon',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        updatedBy: 'admin-1',
        updatedAt: new Date('2026-04-20T12:00:00Z'),
      },
    ];
    merchantState.byId = new Map([['m-amazon', { name: 'Amazon' }]]);
    const res = await adminConfigsCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="loop-cashback-configs.csv"',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Merchant ID,Merchant name,Wholesale %,User cashback %,Loop margin %,Active,Updated by,Updated at (UTC)',
    );
    expect(lines[1]).toBe('m-amazon,Amazon,70.00,25.00,5.00,true,admin-1,2026-04-20T12:00:00.000Z');
  });

  it('falls back to merchantId when the catalog is missing the name', async () => {
    dbState.rows = [
      {
        merchantId: 'm-ghost',
        wholesalePct: '80.00',
        userCashbackPct: '15.00',
        loopMarginPct: '5.00',
        active: false,
        updatedBy: 'admin-2',
        updatedAt: new Date('2026-04-21T09:00:00Z'),
      },
    ];
    const res = await adminConfigsCsvHandler(makeCtx());
    const lines = (await res.text()).trim().split('\r\n');
    // merchantName column falls through to the id when the catalog
    // has evicted the row — admin surface, not marketing.
    expect(lines[1]).toContain('m-ghost,m-ghost');
    // active=false is emitted as the literal "false", not empty.
    expect(lines[1]).toContain(',false,');
  });

  it('RFC-4180-escapes merchant names with commas / quotes / newlines', async () => {
    dbState.rows = [
      {
        merchantId: 'm-tricky',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        updatedBy: 'admin-1',
        updatedAt: new Date('2026-04-20T12:00:00Z'),
      },
    ];
    merchantState.byId = new Map([['m-tricky', { name: 'Foo, "Bar" & Co\nInc.' }]]);
    const res = await adminConfigsCsvHandler(makeCtx());
    const lines = (await res.text()).trim().split('\r\n');
    // The quoted cell spans the line break; split by \r\n won't
    // cleanly partition it, so we inspect the raw body instead.
    const body = await (await adminConfigsCsvHandler(makeCtx())).text();
    expect(body).toContain('"Foo, ""Bar"" & Co\nInc."');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('emits just the header when the configs table is empty', async () => {
    dbState.rows = [];
    const res = await adminConfigsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body.trim().split('\r\n')).toHaveLength(1);
  });

  it('500 when the db read throws', async () => {
    dbState.throw = true;
    const res = await adminConfigsCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
