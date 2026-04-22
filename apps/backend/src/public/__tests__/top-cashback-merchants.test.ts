import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  configRows: [] as Array<{ merchantId: string; userCashbackPct: string }>,
  throwErr: null as Error | null,
  merchants: new Map<
    string,
    { id: string; name: string; logoUrl?: string | null; enabled: boolean }
  >(),
}));

const orderByMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.configRows;
});
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
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
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
    desc: (col: unknown) => ({ __desc: true, col }),
  };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: state.merchants }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  publicTopCashbackMerchantsHandler,
  __resetPublicTopCashbackMerchantsCache,
} from '../top-cashback-merchants.js';

function makeCtx(query: Record<string, string> = {}): Context {
  const headers = new Map<string, string>();
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
    },
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: Object.assign(
          { 'content-type': 'application/json' },
          Object.fromEntries(headers.entries()),
        ),
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.configRows = [];
  state.throwErr = null;
  state.merchants = new Map();
  __resetPublicTopCashbackMerchantsCache();
});

describe('publicTopCashbackMerchantsHandler', () => {
  it('returns empty list with happy-path cache header when no configs exist', async () => {
    const res = await publicTopCashbackMerchantsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await res.json()) as { merchants: unknown[]; asOf: string };
    expect(body.merchants).toEqual([]);
    expect(typeof body.asOf).toBe('string');
  });

  it('joins config pct against the in-memory catalog', async () => {
    state.configRows = [
      { merchantId: 'argos', userCashbackPct: '15.00' },
      { merchantId: 'tesco', userCashbackPct: '10.00' },
    ];
    state.merchants.set('argos', {
      id: 'argos',
      name: 'Argos',
      logoUrl: 'https://example.com/argos.png',
      enabled: true,
    });
    state.merchants.set('tesco', {
      id: 'tesco',
      name: 'Tesco',
      logoUrl: null,
      enabled: true,
    });
    const res = await publicTopCashbackMerchantsHandler(makeCtx());
    const body = (await res.json()) as {
      merchants: Array<Record<string, unknown>>;
    };
    expect(body.merchants).toEqual([
      {
        id: 'argos',
        name: 'Argos',
        logoUrl: 'https://example.com/argos.png',
        userCashbackPct: '15.00',
      },
      {
        id: 'tesco',
        name: 'Tesco',
        logoUrl: null,
        userCashbackPct: '10.00',
      },
    ]);
  });

  it('drops rows whose merchant has been evicted from the catalog (ADR 021 Rule B)', async () => {
    state.configRows = [
      { merchantId: 'evicted', userCashbackPct: '30.00' },
      { merchantId: 'argos', userCashbackPct: '15.00' },
    ];
    state.merchants.set('argos', {
      id: 'argos',
      name: 'Argos',
      enabled: true,
    });
    const res = await publicTopCashbackMerchantsHandler(makeCtx());
    const body = (await res.json()) as {
      merchants: Array<Record<string, unknown>>;
    };
    expect(body.merchants).toHaveLength(1);
    expect(body.merchants[0]!['id']).toBe('argos');
  });

  it('clamps ?limit — 1..50, default 10', async () => {
    state.configRows = Array.from({ length: 60 }, (_, i) => ({
      merchantId: `m-${i}`,
      userCashbackPct: `${(60 - i).toString()}.00`,
    }));
    for (let i = 0; i < 60; i += 1) {
      state.merchants.set(`m-${i}`, { id: `m-${i}`, name: `M${i}`, enabled: true });
    }
    const dflt = (await (await publicTopCashbackMerchantsHandler(makeCtx())).json()) as {
      merchants: unknown[];
    };
    expect(dflt.merchants).toHaveLength(10);

    const huge = (await (
      await publicTopCashbackMerchantsHandler(makeCtx({ limit: '999' }))
    ).json()) as { merchants: unknown[] };
    expect(huge.merchants).toHaveLength(50);

    const tiny = (await (
      await publicTopCashbackMerchantsHandler(makeCtx({ limit: '0' }))
    ).json()) as { merchants: unknown[] };
    expect(tiny.merchants).toHaveLength(1);
  });

  it('never 500s — DB throws serve empty list on bootstrap with max-age=60', async () => {
    state.throwErr = new Error('db exploded');
    const res = await publicTopCashbackMerchantsHandler(makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as { merchants: unknown[] };
    expect(body.merchants).toEqual([]);
  });

  it('serves last-known-good on DB failure after a successful run', async () => {
    state.configRows = [{ merchantId: 'argos', userCashbackPct: '15.00' }];
    state.merchants.set('argos', { id: 'argos', name: 'Argos', enabled: true });
    const first = await publicTopCashbackMerchantsHandler(makeCtx());
    expect(first.status).toBe(200);

    state.throwErr = new Error('db exploded');
    const second = await publicTopCashbackMerchantsHandler(makeCtx());
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await second.json()) as {
      merchants: Array<Record<string, unknown>>;
    };
    expect(body.merchants).toHaveLength(1);
    expect(body.merchants[0]!['name']).toBe('Argos');
  });
});
