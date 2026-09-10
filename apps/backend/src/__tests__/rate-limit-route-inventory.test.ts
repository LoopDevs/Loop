// rate-limit route inventory — hardening C6, 2026-07 plan
import { describe, it, expect, vi } from 'vitest';
import type * as ConfigModule from '../config/index.js';

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      // AUDIT-2-E: required for test-endpoints.ts to mount /__test__/*
      testing: { endpointsSecret: 'rate-limit-inventory-test-secret' },
    },
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

vi.mock('../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

vi.mock('../db/client.js', () => ({
  db: { execute: vi.fn(async () => []) },
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));

import { app } from '../app.js';

const UNLIMITED_ALLOWLIST = new Set<string>([
  // Infra health checks probe this every few seconds from a fixed
  // address; a per-IP budget would page ops on the prober. The
  // handler is a cheap SELECT 1 + in-memory reads.
  'GET /health',
  // Bearer-gated ops probes (production policy: 404 unless the
  // *_BEARER_TOKEN env is set and matches). Scraped by monitoring at
  // a fixed cadence from one address — a per-IP budget would throttle
  // the scraper before any attacker; the unauthenticated path is a
  // constant-time token compare + 404.
  'GET /metrics',
  // Test-only endpoints: mounted only when NODE_ENV=test AND
  // LOOP_TEST_ENDPOINTS_SECRET is configured (AUDIT-2-E defense-in-
  // depth — see test-endpoints.ts) — they do not exist in production
  // route tables. This inventory's env mock sets both so they appear
  // here (they're not rate-limited; a mismatched/missing secret 404s
  // before a limiter would ever be relevant).
  'POST /__test__/reset',
  'POST /__test__/mint-loop-token',
]);

describe('hardening C6 — every route declares a rate limit', () => {
  interface Group {
    method: string;
    path: string;
    limited: boolean;
  }

  function routeGroups(): Group[] {
    const groups = new Map<string, Group>();
    for (const r of app.routes) {
      if (r.path.includes('*')) continue; // namespace blanket middleware
      // `app.use('/exact/path', mw)` registers under the ALL method —
      // path-scoped middleware (auth gates on /api/orders etc.), never
      // a terminating handler. The method-specific mounts of the same
      // paths carry the limiter and are inventoried below.
      if (r.method === 'ALL') continue;
      const key = `${r.method} ${r.path}`;
      const g = groups.get(key) ?? { method: r.method, path: r.path, limited: false };
      const name = (r.handler as { name?: string }).name ?? '';
      if (name.startsWith('rateLimit(')) g.limited = true;
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  it('finds a non-trivial route table (walk is not vacuous)', () => {
    expect(routeGroups().length).toBeGreaterThan(40);
  });

  it('every concrete mount carries a named rateLimit gate or an allowlisted reason', () => {
    const offenders: string[] = [];
    for (const g of routeGroups()) {
      if (g.limited) continue;
      const key = `${g.method} ${g.path}`;
      if (UNLIMITED_ALLOWLIST.has(key)) continue;
      offenders.push(key);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist stays minimal — no stale entries for routes that gained a limiter', () => {
    const groups = new Map(routeGroups().map((g) => [`${g.method} ${g.path}`, g]));
    for (const key of UNLIMITED_ALLOWLIST) {
      const g = groups.get(key);
      expect(g, `${key} is still mounted`).toBeDefined();
      expect(g?.limited, `${key} is still unlimited (drop it from the allowlist)`).toBe(false);
    }
  });
});
