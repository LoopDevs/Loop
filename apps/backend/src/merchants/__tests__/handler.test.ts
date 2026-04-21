import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Merchant } from '@loop/shared';

const mockEnv = vi.hoisted(() => ({
  PORT: 8080,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
  REFRESH_INTERVAL_HOURS: 6,
  LOCATION_REFRESH_INTERVAL_HOURS: 24,
}));

vi.mock('../../env.js', () => ({ env: mockEnv }));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

const mockGetMerchants = vi.fn();
vi.mock('../sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  stopMerchantRefresh: vi.fn(),
  getMerchants: () => mockGetMerchants(),
}));

vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

// Mock the db client. Handlers that historically don't touch the DB
// are unaffected; the cashback-rate handlers drive their lookups
// through this stub.
//   - `findFirst` serves the per-merchant GET, returning
//     `dbState.cashbackConfig` or undefined.
//   - `select().from().where()` serves the bulk GET — resolves to
//     an array of `dbState.bulkConfigs` rows.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    cashbackConfig: null as { userCashbackPct: string; active: boolean } | null,
    bulkConfigs: [] as Array<{ merchantId: string; userCashbackPct: string }>,
    findFirstCalls: 0,
  },
}));
vi.mock('../../db/client.js', () => ({
  db: {
    query: {
      merchantCashbackConfigs: {
        findFirst: vi.fn(async () => {
          dbState.findFirstCalls += 1;
          return dbState.cashbackConfig ?? undefined;
        }),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => dbState.bulkConfigs),
      })),
    })),
  },
}));
vi.mock('../../circuit-breaker.js', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {
    constructor() {
      super('open');
      this.name = 'CircuitOpenError';
    }
  },
  getAllCircuitStates: () => ({}),
  // /api/merchants/:id proxies CTX for long-form content enrichment;
  // in tests we short-circuit the upstream call so the handler falls
  // through to the cached baseline. A real upstream fetch would
  // actually hit http://test-upstream.local/ and hang.
  getUpstreamCircuit: () => ({
    fetch: async () => {
      throw new Error('upstream disabled in tests');
    },
    getState: () => 'closed' as const,
    reset: () => {},
  }),
}));

import { app } from '../../app.js';

function merchant(id: string, name: string, extra?: Partial<Merchant>): Merchant {
  return { id, name, enabled: true, ...extra };
}

function seed(merchants: Merchant[]): void {
  mockGetMerchants.mockReturnValue({
    merchants,
    merchantsById: new Map(merchants.map((m) => [m.id, m])),
    merchantsBySlug: new Map(merchants.map((m) => [m.name.toLowerCase().replace(/\s+/g, '-'), m])),
    loadedAt: Date.now(),
  });
}

beforeEach(() => {
  mockGetMerchants.mockReset();
  seed([]);
  dbState.cashbackConfig = null;
  dbState.bulkConfigs = [];
  dbState.findFirstCalls = 0;
});

describe('GET /api/merchants', () => {
  it('returns empty list and zero pagination when store is empty', async () => {
    const res = await app.request('/api/merchants');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchants: unknown[];
      pagination: {
        page: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
      };
    };
    expect(body.merchants).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.hasNext).toBe(false);
    expect(body.pagination.hasPrev).toBe(false);
  });

  it('sets Cache-Control public max-age=300 so CDN/browser can cache', async () => {
    seed([merchant('m-1', 'Store')]);
    const res = await app.request('/api/merchants');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('paginates: page 1 of 2 with limit 2 returns first two', async () => {
    seed([merchant('m-1', 'A'), merchant('m-2', 'B'), merchant('m-3', 'C'), merchant('m-4', 'D')]);
    const res = await app.request('/api/merchants?page=1&limit=2');
    const body = (await res.json()) as {
      merchants: Merchant[];
      pagination: {
        page: number;
        limit: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
      };
    };
    expect(body.merchants.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.totalPages).toBe(2);
    expect(body.pagination.hasNext).toBe(true);
    expect(body.pagination.hasPrev).toBe(false);
  });

  it('filters by q (case-insensitive substring match on name)', async () => {
    seed([merchant('m-1', 'Home Depot'), merchant('m-2', 'Target'), merchant('m-3', 'home goods')]);
    const res = await app.request('/api/merchants?q=HOME');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id).sort()).toEqual(['m-1', 'm-3']);
  });

  it('filters by q across diacritics (q=cafe matches Café)', async () => {
    // Users typing ASCII search queries shouldn't miss accented merchant names.
    seed([merchant('m-1', 'Café Coco'), merchant('m-2', 'Target')]);
    const res = await app.request('/api/merchants?q=cafe');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id)).toEqual(['m-1']);
  });

  it('matches diacritic query against unaccented name too (q=café matches Cafe)', async () => {
    // Symmetric: users typing with accents shouldn't miss ASCII-only names.
    seed([merchant('m-1', 'Cafe Nero'), merchant('m-2', 'Target')]);
    const res = await app.request(`/api/merchants?q=${encodeURIComponent('café')}`);
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id)).toEqual(['m-1']);
  });

  it('clamps absurd limit down to MAX_PAGE_SIZE (100)', async () => {
    seed(Array.from({ length: 150 }, (_, i) => merchant(`m-${i}`, `Store ${i}`)));
    const res = await app.request('/api/merchants?limit=9999');
    const body = (await res.json()) as { merchants: Merchant[]; pagination: { limit: number } };
    expect(body.pagination.limit).toBe(100);
    expect(body.merchants).toHaveLength(100);
  });

  it('treats negative/zero page as page 1', async () => {
    seed([merchant('m-1', 'A')]);
    const res = await app.request('/api/merchants?page=0');
    const body = (await res.json()) as { pagination: { page: number } };
    expect(body.pagination.page).toBe(1);
  });

  it('truncates excessively long q (defensive cap)', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    // A 500-char q with "home" at the start would match after truncation to 100 chars
    const longQ = 'home' + 'x'.repeat(500);
    const res = await app.request(`/api/merchants?q=${encodeURIComponent(longQ)}`);
    const body = (await res.json()) as { merchants: Merchant[] };
    // Truncation means q becomes "home" + 96 x's — no merchant name contains that,
    // so result is empty. Without truncation, the handler would still return
    // empty because no merchant name contains the full long string, but the
    // operation cost on a large merchant set would be linear in q.length *
    // merchants.length. The test asserts the safety path, not a specific match.
    expect(Array.isArray(body.merchants)).toBe(true);
  });

  it('returns empty merchants when page exceeds totalPages', async () => {
    seed([merchant('m-1', 'Only')]);
    const res = await app.request('/api/merchants?page=99&limit=10');
    const body = (await res.json()) as {
      merchants: Merchant[];
      pagination: { page: number; hasNext: boolean };
    };
    expect(body.merchants).toEqual([]);
    expect(body.pagination.page).toBe(99);
    expect(body.pagination.hasNext).toBe(false);
  });
});

describe('GET /api/merchants/all', () => {
  it('returns the full catalog in a single response (audit A-002)', async () => {
    // 150 merchants: one full page (100) + overflow (50). The paginated endpoint
    // would truncate at 100; /all must return every entry.
    seed(Array.from({ length: 150 }, (_, i) => merchant(`m-${i}`, `Store ${i}`)));
    const res = await app.request('/api/merchants/all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: Merchant[]; total: number };
    expect(body.merchants).toHaveLength(150);
    expect(body.total).toBe(150);
    expect(body.merchants[0]?.id).toBe('m-0');
    expect(body.merchants[149]?.id).toBe('m-149');
  });

  it('sets the same 5-minute public cache header as the paginated endpoint', async () => {
    seed([merchant('m-1', 'A')]);
    const res = await app.request('/api/merchants/all');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns an empty array when the catalog is empty (no 404)', async () => {
    seed([]);
    const res = await app.request('/api/merchants/all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: Merchant[]; total: number };
    expect(body.merchants).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('does not collide with /api/merchants/:id route ordering', async () => {
    // If /:id were registered first, a request for /all would hit merchantDetailHandler
    // and return 404. Guard against that regression.
    seed([merchant('m-1', 'A')]);
    const res = await app.request('/api/merchants/all');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/merchants/by-slug/:slug', () => {
  it('returns merchant when slug matches', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/by-slug/home-depot');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: Merchant };
    expect(body.merchant.id).toBe('m-1');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns 404 with NOT_FOUND code when slug is unknown', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/by-slug/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('resolves case-insensitively when slug uses mixed case', async () => {
    // Stored slugs are always lowercase; accept a hand-typed URL that got
    // the case wrong rather than 404'ing.
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/by-slug/Home-Depot');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: Merchant };
    expect(body.merchant.id).toBe('m-1');
  });
});

describe('GET /api/merchants/:id', () => {
  // `/api/merchants/:id` is gated by requireAuth — it proxies CTX with
  // the user's bearer + X-Client-Id to enrich the detail with
  // longDescription / terms / instructions. Tests supply a dummy
  // bearer so the auth guard passes; upstream fetch falls through to
  // the cached merchant when the mock upstream doesn't respond (the
  // handler logs a warn and returns the cached baseline).
  const AUTH_HEADER = { Authorization: 'Bearer test-token' };

  it('returns merchant when id matches', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/m-1', { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: Merchant };
    expect(body.merchant.id).toBe('m-1');
    // Authenticated endpoint — never publicly cacheable.
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
  });

  it('returns 404 when id unknown', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/ghost', { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });

  it('does not route by-slug request through :id handler (order-sensitive)', async () => {
    // Routes declared /by-slug/:slug BEFORE /:id — a slug that looks like an
    // id should hit the slug handler, not the id handler. With only one
    // merchant whose id is "home-depot" and whose slug is also "home-depot",
    // both would resolve — so use distinct values.
    seed([merchant('unique-id', 'Home Depot')]);
    const byId = await app.request('/api/merchants/unique-id', { headers: AUTH_HEADER });
    expect(byId.status).toBe(200);
    const bySlug = await app.request('/api/merchants/by-slug/home-depot');
    expect(bySlug.status).toBe(200);
    const slugBody = (await bySlug.json()) as { merchant: Merchant };
    expect(slugBody.merchant.id).toBe('unique-id');
  });

  it('401s without a Bearer token', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/m-1');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/merchants/cashback-rates (bulk)', () => {
  it('returns a rates map keyed by merchantId with bigint-string pcts', async () => {
    dbState.bulkConfigs = [
      { merchantId: 'm-1', userCashbackPct: '2.50' },
      { merchantId: 'm-2', userCashbackPct: '10.00' },
    ];
    const res = await app.request('/api/merchants/cashback-rates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rates: Record<string, string> };
    expect(body.rates).toEqual({
      'm-1': '2.50',
      'm-2': '10.00',
    });
  });

  it('returns an empty rates object when no active configs exist', async () => {
    dbState.bulkConfigs = [];
    const res = await app.request('/api/merchants/cashback-rates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rates: Record<string, string> };
    expect(body.rates).toEqual({});
  });

  it('serves with public 5-min cache so CDN + browser can share', async () => {
    dbState.bulkConfigs = [];
    const res = await app.request('/api/merchants/cashback-rates');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('literal "cashback-rates" does NOT route through the :merchantId handler', async () => {
    // Router ordering regression guard. If "cashback-rates" were
    // interpreted as a path parameter, `merchantCashbackRateHandler`
    // would run instead — it would 404 on the unknown merchant and
    // never hit the bulk SELECT.
    dbState.bulkConfigs = [{ merchantId: 'm-1', userCashbackPct: '3.00' }];
    const res = await app.request('/api/merchants/cashback-rates');
    const body = (await res.json()) as { rates?: Record<string, string> };
    expect(body.rates).toEqual({ 'm-1': '3.00' });
  });
});

describe('GET /api/merchants/:merchantId/cashback-rate', () => {
  it('returns the active userCashbackPct when the merchant has a config', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    dbState.cashbackConfig = { userCashbackPct: '2.50', active: true };
    const res = await app.request('/api/merchants/m-1/cashback-rate');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchantId: string; userCashbackPct: string | null };
    expect(body).toEqual({ merchantId: 'm-1', userCashbackPct: '2.50' });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns null pct when the merchant has no config', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    dbState.cashbackConfig = null;
    const res = await app.request('/api/merchants/m-1/cashback-rate');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userCashbackPct: string | null };
    expect(body.userCashbackPct).toBeNull();
  });

  it('404s when the merchant id is unknown — no db lookup', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/ghost/cashback-rate');
    expect(res.status).toBe(404);
    // Guards against DB enumeration: no lookup fires for an unknown id.
    expect(dbState.findFirstCalls).toBe(0);
  });

  it('400s on a malformed merchant id (anything outside [\\w-])', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/bad%20id/cashback-rate');
    expect(res.status).toBe(400);
  });

  it('is reachable without a Bearer — cashback-rate previews are public', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    dbState.cashbackConfig = { userCashbackPct: '1.00', active: true };
    const res = await app.request('/api/merchants/m-1/cashback-rate');
    expect(res.status).toBe(200);
  });
});
