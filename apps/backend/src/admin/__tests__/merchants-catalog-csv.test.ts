import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  configRows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  merchants: [] as Array<{ id: string; name: string; enabled: boolean }>,
}));

const whereMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.configRows;
});
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  merchantCashbackConfigs: {
    merchantId: 'merchant_cashback_configs.merchant_id',
    userCashbackPct: 'merchant_cashback_configs.user_cashback_pct',
    active: 'merchant_cashback_configs.active',
    updatedBy: 'merchant_cashback_configs.updated_by',
    updatedAt: 'merchant_cashback_configs.updated_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
  };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchants: state.merchants }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminMerchantsCatalogCsvHandler } from '../merchants-catalog-csv.js';

function makeCtx(): Context {
  return {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.configRows = [];
  state.throwErr = null;
  state.merchants = [];
});

describe('adminMerchantsCatalogCsvHandler', () => {
  it('returns header-only CSV when the catalog is empty', async () => {
    const res = await adminMerchantsCatalogCsvHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="merchants-catalog-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(
      body.startsWith('merchant_id,name,enabled,user_cashback_pct,active,updated_by,updated_at'),
    ).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per catalog merchant joined against config data', async () => {
    state.merchants = [
      { id: 'amazon_us', name: 'Amazon', enabled: true },
      { id: 'tesco_uk', name: 'Tesco', enabled: true },
      { id: 'new_merchant', name: 'New Merchant', enabled: true },
    ];
    state.configRows = [
      {
        merchantId: 'amazon_us',
        userCashbackPct: '5.50',
        active: true,
        updatedBy: 'ash@loop',
        updatedAt: new Date('2026-04-20T10:00:00Z'),
      },
      {
        merchantId: 'tesco_uk',
        userCashbackPct: '2.00',
        active: false,
        updatedBy: 'bd@loop',
        updatedAt: new Date('2026-04-21T11:00:00Z'),
      },
    ];
    const res = await adminMerchantsCatalogCsvHandler(makeCtx());
    const lines = (await res.text()).split('\r\n').filter((l) => l.length > 0);
    expect(lines).toEqual([
      'merchant_id,name,enabled,user_cashback_pct,active,updated_by,updated_at',
      'amazon_us,Amazon,true,5.50,true,ash@loop,2026-04-20T10:00:00.000Z',
      'tesco_uk,Tesco,true,2.00,false,bd@loop,2026-04-21T11:00:00.000Z',
      'new_merchant,New Merchant,true,,,,',
    ]);
  });

  it('escapes commas and quotes in merchant names per RFC 4180', async () => {
    state.merchants = [
      { id: 'weird_1', name: 'Name, With Comma', enabled: true },
      { id: 'weird_2', name: 'Name "With" Quotes', enabled: true },
    ];
    const res = await adminMerchantsCatalogCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toMatch(/\r\nweird_1,"Name, With Comma",true,,,,\r\n/);
    expect(body).toMatch(/\r\nweird_2,"Name ""With"" Quotes",true,,,,\r\n/);
  });

  it('emits enabled=false for catalog-disabled merchants', async () => {
    state.merchants = [{ id: 'm_off', name: 'Off', enabled: false }];
    const res = await adminMerchantsCatalogCsvHandler(makeCtx());
    const body = await res.text();
    expect(body).toMatch(/\r\nm_off,Off,false,,,,\r\n/);
  });

  it('appends __TRUNCATED__ sentinel when the row cap is exceeded', async () => {
    state.merchants = Array.from({ length: 10_001 }, (_, i) => ({
      id: `m_${i}`,
      name: `Merchant ${i}`,
      enabled: true,
    }));
    const res = await adminMerchantsCatalogCsvHandler(makeCtx());
    const lines = (await res.text()).split('\r\n').filter((l) => l.length > 0);
    // 1 header + 10_000 rows + 1 sentinel = 10_002.
    expect(lines).toHaveLength(10_002);
    expect(lines.at(-1)).toBe('__TRUNCATED__');
  });

  it('500 when the db throws', async () => {
    // A2-503: the configs SELECT is now skipped when the emitted-
    // merchants list is empty, so this fixture needs at least one
    // catalog merchant to exercise the DB-error path.
    state.merchants = [{ id: 'm_1', name: 'Merchant One', enabled: true }];
    state.throwErr = new Error('db exploded');
    const res = await adminMerchantsCatalogCsvHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
