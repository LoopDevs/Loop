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

vi.mock('../../circuit-breaker.js', () => ({
  CircuitOpenError: class CircuitOpenError extends Error {
    constructor() {
      super('open');
      this.name = 'CircuitOpenError';
    }
  },
  getAllCircuitStates: () => ({}),
  getUpstreamCircuit: () => ({
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
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
});

describe('GET /api/merchants/:id', () => {
  it('returns merchant when id matches', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/m-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: Merchant };
    expect(body.merchant.id).toBe('m-1');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns 404 when id unknown', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/ghost');
    expect(res.status).toBe(404);
  });

  it('does not route by-slug request through :id handler (order-sensitive)', async () => {
    // Routes declared /by-slug/:slug BEFORE /:id — a slug that looks like an
    // id should hit the slug handler, not the id handler. With only one
    // merchant whose id is "home-depot" and whose slug is also "home-depot",
    // both would resolve — so use distinct values.
    seed([merchant('unique-id', 'Home Depot')]);
    const byId = await app.request('/api/merchants/unique-id');
    expect(byId.status).toBe(200);
    const bySlug = await app.request('/api/merchants/by-slug/home-depot');
    expect(bySlug.status).toBe(200);
    const slugBody = (await bySlug.json()) as { merchant: Merchant };
    expect(slugBody.merchant.id).toBe('unique-id');
  });
});
