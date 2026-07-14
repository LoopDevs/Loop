import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Merchant } from '@loop/shared';

const mockEnv = vi.hoisted(() => ({
  PORT: 8080,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
  REFRESH_INTERVAL_HOURS: 6,
  LOCATION_REFRESH_INTERVAL_HOURS: 24,
  // Rate-limit test below drives requests via the spoof-proof `Fly-Client-IP`
  // header (FT-08) — matches the auth handler test's pattern
  // (auth/__tests__/handler.test.ts).
  TRUST_PROXY: true,
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

vi.mock('../../db/client.js', () => ({
  db: {
    query: { merchantCashbackConfigs: { findFirst: vi.fn(async () => undefined) } },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
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
});

describe('GET /api/merchants/search', () => {
  it('returns an empty result when q is missing (never a full-catalog dump)', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request('/api/merchants/search');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: Merchant[]; total: number };
    expect(body.merchants).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns an empty result for an empty/whitespace q', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const res = await app.request(`/api/merchants/search?q=${encodeURIComponent('   ')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: Merchant[]; total: number };
    expect(body.merchants).toEqual([]);
  });

  it('filters by q (case-insensitive substring match on name) — same semantics as /api/merchants?q=', async () => {
    seed([merchant('m-1', 'Home Depot'), merchant('m-2', 'Target'), merchant('m-3', 'home goods')]);
    const res = await app.request('/api/merchants/search?q=HOME');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id).sort()).toEqual(['m-1', 'm-3']);
  });

  it('filters across diacritics (q=cafe matches Café)', async () => {
    seed([merchant('m-1', 'Café Coco'), merchant('m-2', 'Target')]);
    const res = await app.request('/api/merchants/search?q=cafe');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id)).toEqual(['m-1']);
  });

  it('excludes disabled merchants (dev-mode INCLUDE_DISABLED_MERCHANTS parity with the client filters)', async () => {
    seed([merchant('m-1', 'Home Depot', { enabled: false }), merchant('m-2', 'Home Goods')]);
    const res = await app.request('/api/merchants/search?q=home');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id)).toEqual(['m-2']);
  });

  it('strips description/instructions/terms (lite projection, matching ?fields=lite)', async () => {
    seed([
      merchant('m-1', 'Acme', {
        description: 'Long description',
        instructions: 'Redeem online',
        terms: 'Standard terms',
        intro: 'Great value',
      }),
    ]);
    const res = await app.request('/api/merchants/search?q=acme');
    const body = (await res.json()) as { merchants: Merchant[] };
    const m = body.merchants[0]!;
    expect(m.description).toBeUndefined();
    expect(m.instructions).toBeUndefined();
    expect(m.terms).toBeUndefined();
    expect(m.intro).toBe('Great value');
  });

  it('bounds results at the default limit (20)', async () => {
    seed(Array.from({ length: 30 }, (_, i) => merchant(`m-${i}`, `Store ${i}`)));
    const res = await app.request('/api/merchants/search?q=store');
    const body = (await res.json()) as { merchants: Merchant[]; total: number };
    expect(body.merchants).toHaveLength(20);
    expect(body.total).toBe(30);
  });

  it('honours an explicit limit, clamped to MAX_LIMIT (50)', async () => {
    seed(Array.from({ length: 80 }, (_, i) => merchant(`m-${i}`, `Store ${i}`)));
    const res = await app.request('/api/merchants/search?q=store&limit=9999');
    const body = (await res.json()) as { merchants: Merchant[]; total: number };
    expect(body.merchants).toHaveLength(50);
    expect(body.total).toBe(80);
  });

  it('clamps a negative limit up to 1 (parseInt("-5") is truthy, unlike "0")', async () => {
    // Mirrors merchantListHandler's existing `parseInt(...) || DEFAULT` pattern:
    // limit=0 falls back to the default (0 is falsy) — not a floor-to-1 case.
    // A genuinely negative value exercises the Math.max(1, …) floor.
    seed([merchant('m-1', 'Store A'), merchant('m-2', 'Store B')]);
    const res = await app.request('/api/merchants/search?q=store&limit=-5');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants).toHaveLength(1);
  });

  it('falls back to the default limit (20) when limit=0 (matches merchantListHandler precedent)', async () => {
    seed([merchant('m-1', 'Store A'), merchant('m-2', 'Store B')]);
    const res = await app.request('/api/merchants/search?q=store&limit=0');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants).toHaveLength(2);
  });

  it('ranks by savingsPercentage descending when no country is supplied', async () => {
    seed([
      merchant('low', 'Store Low', { savingsPercentage: 1 }),
      merchant('high', 'Store High', { savingsPercentage: 9 }),
      merchant('mid', 'Store Mid', { savingsPercentage: 5 }),
    ]);
    const res = await app.request('/api/merchants/search?q=store');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id)).toEqual(['high', 'mid', 'low']);
  });

  it('ranks in-country matches first, then by savingsPercentage, when country is supplied', async () => {
    seed([
      merchant('gb-low', 'Store GB Low', { country: 'GB', savingsPercentage: 1 }),
      merchant('us-high', 'Store US High', { country: 'US', savingsPercentage: 9 }),
      merchant('gb-high', 'Store GB High', { country: 'GB', savingsPercentage: 8 }),
    ]);
    const res = await app.request('/api/merchants/search?q=store&country=gb');
    const body = (await res.json()) as { merchants: Merchant[] };
    // Both GB merchants rank ahead of the higher-savings US merchant;
    // within GB, savings desc still applies.
    expect(body.merchants.map((m) => m.id)).toEqual(['gb-high', 'gb-low', 'us-high']);
  });

  it('does not filter out other-country merchants — country only ranks', async () => {
    seed([merchant('us-1', 'Store US', { country: 'US' })]);
    const res = await app.request('/api/merchants/search?q=store&country=gb');
    const body = (await res.json()) as { merchants: Merchant[] };
    expect(body.merchants.map((m) => m.id)).toEqual(['us-1']);
  });

  it('is rate-limited (429 after exceeding the per-IP budget)', async () => {
    seed([merchant('m-1', 'Store A')]);
    let last: Response | undefined;
    for (let i = 0; i < 181; i++) {
      last = await app.request('/api/merchants/search?q=store', {
        headers: { 'fly-client-ip': '203.0.113.9' },
      });
    }
    expect(last?.status).toBe(429);
  });

  it('never 500s on a very long q (truncated, not rejected)', async () => {
    seed([merchant('m-1', 'Home Depot')]);
    const longQ = 'home' + 'x'.repeat(500);
    const res = await app.request(`/api/merchants/search?q=${encodeURIComponent(longQ)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: unknown[] };
    expect(Array.isArray(body.merchants)).toBe(true);
  });

  it('never 500s on special characters / weird input in q or country', async () => {
    seed([merchant('m-1', "Dunkin' Donuts")]);
    const res = await app.request(
      `/api/merchants/search?${new URLSearchParams({
        q: "'; DROP TABLE merchants; --<script>",
        country: '💥bad',
      }).toString()}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchants: unknown[]; total: number };
    expect(Array.isArray(body.merchants)).toBe(true);
    expect(body.total).toBe(0);
  });

  it('sets a public 5-minute cache header, matching sibling merchant endpoints', async () => {
    seed([merchant('m-1', 'Store A')]);
    const res = await app.request('/api/merchants/search?q=store');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('does not collide with /api/merchants/:id route ordering', async () => {
    seed([merchant('m-1', 'A')]);
    const res = await app.request('/api/merchants/search?q=a');
    expect(res.status).toBe(200);
  });
});
