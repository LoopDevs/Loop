import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  merchantsById: new Map<string, { id: string; name: string }>(),
}));

const limitMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ orderBy: orderByMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: {
    merchantId: 'merchant_cashback_configs.merchant_id',
    wholesalePct: 'merchant_cashback_configs.wholesale_pct',
    userCashbackPct: 'merchant_cashback_configs.user_cashback_pct',
    loopMarginPct: 'merchant_cashback_configs.loop_margin_pct',
    active: 'merchant_cashback_configs.active',
    updatedBy: 'merchant_cashback_configs.updated_by',
    updatedAt: 'merchant_cashback_configs.updated_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    desc: (col: unknown) => ({ __desc: true, col }),
  };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: state.merchantsById }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminCashbackConfigsCsvHandler } from '../cashback-configs-csv.js';

function makeCtx(): Context {
  return {
    req: {
      query: (_k: string) => undefined,
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
  state.merchantsById = new Map();
  selectMock.mockClear();
  fromMock.mockClear();
  orderByMock.mockClear();
  limitMock.mockClear();
});

describe('adminCashbackConfigsCsvHandler', () => {
  it('emits headers + Content-Disposition even when the table is empty', async () => {
    state.rows = [];
    const res = await adminCashbackConfigsCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    expect(body.split('\r\n')[0]).toBe(
      'merchant_id,merchant_name,wholesale_pct,user_cashback_pct,loop_margin_pct,active,updated_by,updated_at',
    );
  });

  it('renders one CSV row per config, resolving merchant name from the catalog', async () => {
    state.merchantsById.set('amazon', { id: 'amazon', name: 'Amazon' });
    state.merchantsById.set('tesco', { id: 'tesco', name: 'Tesco' });
    state.rows = [
      {
        merchantId: 'amazon',
        wholesalePct: '70.00',
        userCashbackPct: '25.00',
        loopMarginPct: '5.00',
        active: true,
        updatedBy: 'admin-abc',
        updatedAt: new Date('2026-04-22T14:00:00Z'),
      },
      {
        merchantId: 'tesco',
        wholesalePct: '60.00',
        userCashbackPct: '30.00',
        loopMarginPct: '10.00',
        active: false,
        updatedBy: 'admin-def',
        updatedAt: new Date('2026-04-10T09:30:00Z'),
      },
    ];
    const res = await adminCashbackConfigsCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toBe('amazon,Amazon,70.00,25.00,5.00,true,admin-abc,2026-04-22T14:00:00.000Z');
    expect(lines[2]).toBe('tesco,Tesco,60.00,30.00,10.00,false,admin-def,2026-04-10T09:30:00.000Z');
  });

  it('falls back to merchant_id as the display name when the catalog has evicted the merchant (ADR 021 Rule A)', async () => {
    state.merchantsById = new Map(); // nothing configured
    state.rows = [
      {
        merchantId: 'ghost',
        wholesalePct: '50.00',
        userCashbackPct: '40.00',
        loopMarginPct: '10.00',
        active: true,
        updatedBy: 'admin-x',
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      },
    ];
    const res = await adminCashbackConfigsCsvHandler(makeCtx());
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines[1]).toBe('ghost,ghost,50.00,40.00,10.00,true,admin-x,2026-04-22T00:00:00.000Z');
  });

  it('escapes a merchant name containing commas / quotes per RFC 4180', async () => {
    state.merchantsById.set('m-1', { id: 'm-1', name: 'Acme, Inc. "Retail"' });
    state.rows = [
      {
        merchantId: 'm-1',
        wholesalePct: '70.00',
        userCashbackPct: '20.00',
        loopMarginPct: '10.00',
        active: true,
        updatedBy: 'admin-a',
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      },
    ];
    const res = await adminCashbackConfigsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toContain('"Acme, Inc. ""Retail"""');
  });

  it('emits __TRUNCATED__ when row count exceeds the cap', async () => {
    // Pretend the DB returns ROW_CAP + 5 rows. The handler pulls LIMIT
    // ROW_CAP + 1, detects the +1, and emits the sentinel. Use a small
    // synthesised set so we don't allocate 10k mock rows — we just
    // need the array length to exceed the cap.
    state.rows = new Array(10_001).fill(null).map((_, i) => ({
      merchantId: `m-${i}`,
      wholesalePct: '70.00',
      userCashbackPct: '20.00',
      loopMarginPct: '10.00',
      active: true,
      updatedBy: 'admin-x',
      updatedAt: new Date('2026-04-22T00:00:00Z'),
    }));
    const res = await adminCashbackConfigsCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toMatch(/__TRUNCATED__/);
  });

  it('500 when the DB query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminCashbackConfigsCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
