import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  configRows: [] as Array<{ userCashbackPct: string }>,
  throwErr: null as Error | null,
  merchantsById: new Map<
    string,
    { id: string; name: string; logoUrl?: string | null; enabled: boolean }
  >(),
  merchantsBySlug: new Map<
    string,
    { id: string; name: string; logoUrl?: string | null; enabled: boolean }
  >(),
}));

const limitMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.configRows;
});
const whereMock = vi.fn(() => ({ limit: limitMock }));
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
    and: (...parts: unknown[]) => ({ __and: true, parts }),
  };
});

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({
    merchantsById: state.merchantsById,
    merchantsBySlug: state.merchantsBySlug,
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { publicMerchantHandler, __resetPublicMerchantCache } from '../merchant.js';

function makeCtx(params: Record<string, string | undefined> = {}): Context {
  const headers = new Map<string, string>();
  return {
    req: { param: (k: string) => params[k] },
    header: (k: string, v: string) => {
      headers.set(k, v);
    },
    json: (body: unknown, status?: number) => {
      const init: ResponseInit = {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      };
      const res = new Response(JSON.stringify(body), init);
      for (const [k, v] of headers) res.headers.set(k, v);
      return res;
    },
  } as unknown as Context;
}

beforeEach(() => {
  state.configRows = [];
  state.throwErr = null;
  state.merchantsById = new Map();
  state.merchantsBySlug = new Map();
  __resetPublicMerchantCache();
});

describe('publicMerchantHandler', () => {
  it('400 when id is missing', async () => {
    const res = await publicMerchantHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when id has disallowed characters', async () => {
    const res = await publicMerchantHandler(makeCtx({ id: 'bad slug' }));
    expect(res.status).toBe(400);
  });

  it('404 when id is not in the catalog', async () => {
    const res = await publicMerchantHandler(makeCtx({ id: 'no_such_merchant' }));
    expect(res.status).toBe(404);
  });

  it('happy path resolves by id with active cashback pct', async () => {
    state.merchantsById.set('amazon_us', {
      id: 'amazon_us',
      name: 'Amazon',
      logoUrl: 'https://cdn/amazon.png',
      enabled: true,
    });
    state.configRows = [{ userCashbackPct: '5.50' }];
    const res = await publicMerchantHandler(makeCtx({ id: 'amazon_us' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await res.json()) as {
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
      userCashbackPct: string | null;
      asOf: string;
    };
    expect(body.id).toBe('amazon_us');
    expect(body.name).toBe('Amazon');
    expect(body.slug).toBe('amazon');
    expect(body.logoUrl).toBe('https://cdn/amazon.png');
    expect(body.userCashbackPct).toBe('5.50');
    expect(typeof body.asOf).toBe('string');
  });

  it('returns null userCashbackPct for a catalog merchant with no active config (coming-soon state)', async () => {
    state.merchantsById.set('new_merchant', {
      id: 'new_merchant',
      name: 'New Merchant',
      logoUrl: null,
      enabled: true,
    });
    state.configRows = [];
    const res = await publicMerchantHandler(makeCtx({ id: 'new_merchant' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userCashbackPct: string | null };
    expect(body.userCashbackPct).toBeNull();
  });

  it('resolves by slug as well as id', async () => {
    state.merchantsBySlug.set('tesco', {
      id: 'tesco_uk',
      name: 'Tesco',
      logoUrl: null,
      enabled: true,
    });
    state.configRows = [{ userCashbackPct: '2.00' }];
    const res = await publicMerchantHandler(makeCtx({ id: 'tesco' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    // Returns the canonical merchant id, not the slug that was passed in.
    expect(body.id).toBe('tesco_uk');
    expect(body.slug).toBe('tesco');
  });

  it('never-500s on DB trouble — serves last-known-good from cache', async () => {
    state.merchantsById.set('amazon_us', {
      id: 'amazon_us',
      name: 'Amazon',
      logoUrl: null,
      enabled: true,
    });
    // First call: seeds the cache.
    state.configRows = [{ userCashbackPct: '5.50' }];
    await publicMerchantHandler(makeCtx({ id: 'amazon_us' }));

    // Second call: DB throws. Must not 500.
    state.throwErr = new Error('db exploded');
    const res = await publicMerchantHandler(makeCtx({ id: 'amazon_us' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as { userCashbackPct: string | null };
    expect(body.userCashbackPct).toBe('5.50');
  });

  it('never-500s on first-miss DB trouble — serves catalog row with null pct', async () => {
    state.merchantsById.set('amazon_us', {
      id: 'amazon_us',
      name: 'Amazon',
      logoUrl: null,
      enabled: true,
    });
    state.throwErr = new Error('db exploded');
    const res = await publicMerchantHandler(makeCtx({ id: 'amazon_us' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await res.json()) as { id: string; userCashbackPct: string | null };
    expect(body.id).toBe('amazon_us');
    expect(body.userCashbackPct).toBeNull();
  });
});
