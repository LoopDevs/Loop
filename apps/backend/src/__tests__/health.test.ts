import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * `/health` had zero test coverage before this file. Added alongside
 * CF2-01 (2026-06-30 cold audit) to protect the new operator-pool
 * exposure, and to close the pre-existing gap while touching this file.
 */

const {
  locationsState,
  merchantsState,
  runtimeState,
  dbState,
  operatorHealthMock,
  geoDbState,
  notifyGeoDbStaleMock,
  fleetSizeState,
} = vi.hoisted(() => ({
  locationsState: { locations: [] as unknown[], loadedAt: Date.now(), loading: false },
  merchantsState: { merchants: [] as unknown[], loadedAt: Date.now() },
  runtimeState: {
    degraded: false,
    otpDelivery: {
      enabled: true,
      lastSuccessAtMs: null,
      lastFailureAtMs: null,
      lastError: null,
      degraded: false,
    },
    workers: [] as unknown[],
  },
  dbState: { shouldFail: false },
  operatorHealthMock: vi.fn(() => [] as Array<{ id: string; state: string }>),
  // Defaults mirror the "unconfigured" GeoDbStatus (public/geo.ts) —
  // most tests don't care about geo staleness, so the baseline must not
  // spuriously soft-degrade / page.
  geoDbState: {
    available: false,
    buildEpoch: null as string | null,
    ageDays: null as number | null,
    stale: false,
  },
  notifyGeoDbStaleMock: vi.fn(),
  // S4-4: default mirrors the "static fallback" posture — most tests
  // don't care about the fleet-size source, so the baseline must not
  // spuriously imply a live DNS read is in effect.
  fleetSizeState: { estimate: 1, source: 'static' as 'dynamic' | 'static' },
}));

vi.mock('../clustering/data-store.js', () => ({
  getLocations: () => ({ locations: locationsState.locations, loadedAt: locationsState.loadedAt }),
  isLocationLoading: () => locationsState.loading,
}));

vi.mock('../merchants/sync.js', () => ({
  getMerchants: () => ({ merchants: merchantsState.merchants, loadedAt: merchantsState.loadedAt }),
}));

vi.mock('../runtime-health.js', () => ({
  getRuntimeHealthSnapshot: () => runtimeState,
}));

vi.mock('../discord.js', () => ({
  notifyHealthChange: vi.fn(),
  notifyGeoDbStale: notifyGeoDbStaleMock,
}));

vi.mock('../public/geo.js', () => ({
  getGeoDbStatus: () => Promise.resolve(geoDbState),
  GEO_DB_STALE_AFTER_DAYS: 45,
}));

vi.mock('../middleware/fleet-size.js', () => ({
  currentFleetSizeEstimate: () => fleetSizeState.estimate,
  currentFleetSizeSource: () => fleetSizeState.source,
}));

vi.mock('../upstream.js', () => ({
  upstreamUrl: (path: string) => `https://upstream.example.com${path}`,
}));

vi.mock('../db/client.js', () => ({
  db: {
    execute: async () => {
      if (dbState.shouldFail) throw new Error('db down');
      return [];
    },
  },
}));

vi.mock('../ctx/operator-pool.js', () => ({
  getOperatorHealth: operatorHealthMock,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  healthHandler,
  __resetHealthProbeCacheForTests,
  __resetDbProbeCacheForTests,
} from '../health.js';

function makeCtx(): { ctx: Context; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const ctx = {
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
  return { ctx, headers };
}

beforeEach(() => {
  locationsState.locations = [];
  locationsState.loadedAt = Date.now();
  locationsState.loading = false;
  merchantsState.merchants = [];
  merchantsState.loadedAt = Date.now();
  runtimeState.degraded = false;
  runtimeState.otpDelivery.degraded = false;
  runtimeState.workers = [];
  dbState.shouldFail = false;
  operatorHealthMock.mockReset().mockReturnValue([]);
  fetchMock.mockReset().mockResolvedValue(new Response('ok', { status: 200 }));
  geoDbState.available = false;
  geoDbState.buildEpoch = null;
  geoDbState.ageDays = null;
  geoDbState.stale = false;
  notifyGeoDbStaleMock.mockReset();
  fleetSizeState.estimate = 1;
  fleetSizeState.source = 'static';
  __resetHealthProbeCacheForTests();
  __resetDbProbeCacheForTests();
});

describe('healthHandler', () => {
  it('200 healthy when everything is up and the operator pool has no exhausted breakers', async () => {
    operatorHealthMock.mockReturnValue([
      { id: 'op-1', state: 'closed' },
      { id: 'op-2', state: 'closed' },
    ]);
    const { ctx } = makeCtx();
    const res = await healthHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      operatorPool: unknown;
      operatorPoolExhausted: boolean;
      softDegradedReasons: string[];
    };
    expect(body.status).toBe('healthy');
    expect(body.operatorPool).toEqual([
      { id: 'op-1', state: 'closed' },
      { id: 'op-2', state: 'closed' },
    ]);
    expect(body.operatorPoolExhausted).toBe(false);
    expect(body.softDegradedReasons).not.toContain('operator_pool_exhausted');
  });

  it('503 critical when the database is unreachable', async () => {
    dbState.shouldFail = true;
    const { ctx } = makeCtx();
    const res = await healthHandler(ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; databaseReachable: boolean };
    expect(body.status).toBe('degraded');
    expect(body.databaseReachable).toBe(false);
  });

  // CF2-01 (2026-06-30 cold audit): the operator-pool circuit-breaker
  // state was previously invisible to /health entirely. These pin the
  // new exposure and its SOFT (not critical) classification — a pool-
  // wide CTX outage shouldn't cycle this backend instance, since the
  // isAvailable() fix means the pool recovers on its own schedule and
  // cycling the machine wouldn't fix an upstream CTX outage.
  describe('operator pool exposure', () => {
    it('surfaces every operator breaker state in the response body', async () => {
      operatorHealthMock.mockReturnValue([
        { id: 'op-1', state: 'open' },
        { id: 'op-2', state: 'closed' },
      ]);
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      const body = (await res.json()) as { operatorPool: Array<{ id: string; state: string }> };
      expect(body.operatorPool).toEqual([
        { id: 'op-1', state: 'open' },
        { id: 'op-2', state: 'closed' },
      ]);
    });

    it('flags operatorPoolExhausted as a SOFT degraded reason (200, not 503) when every operator is OPEN', async () => {
      operatorHealthMock.mockReturnValue([
        { id: 'op-1', state: 'open' },
        { id: 'op-2', state: 'open' },
      ]);
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      // Soft-degraded, not critical — does NOT return 503 / cycle the machine.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        operatorPoolExhausted: boolean;
        softDegraded: boolean;
        criticalDegraded: boolean;
        softDegradedReasons: string[];
      };
      expect(body.status).toBe('degraded');
      expect(body.operatorPoolExhausted).toBe(true);
      expect(body.softDegraded).toBe(true);
      expect(body.criticalDegraded).toBe(false);
      expect(body.softDegradedReasons).toContain('operator_pool_exhausted');
    });

    it('does not flag exhausted when at least one operator is available', async () => {
      operatorHealthMock.mockReturnValue([
        { id: 'op-1', state: 'open' },
        { id: 'op-2', state: 'half_open' },
      ]);
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      const body = (await res.json()) as { operatorPoolExhausted: boolean };
      expect(body.operatorPoolExhausted).toBe(false);
    });

    it('an empty operator pool (none configured) does not falsely report exhausted', async () => {
      operatorHealthMock.mockReturnValue([]);
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      const body = (await res.json()) as { operatorPoolExhausted: boolean };
      expect(body.operatorPoolExhausted).toBe(false);
    });
  });

  it('sets Cache-Control: no-store', async () => {
    const { ctx, headers } = makeCtx();
    await healthHandler(ctx);
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  // S4-4: purely informational exposure of the rate limiter's current
  // fleet-size divisor (middleware/fleet-size.ts) — mirrors the
  // geoDbStale/geoDbBuildEpoch shape added in PR #1588. Neither field
  // affects softDegraded/criticalDegraded/status; these tests pin that
  // as well as the plumbing from the (mocked) estimator through to the
  // response body.
  describe('rate limit fleet estimate', () => {
    it('reports the dynamic estimate + source when a live DNS read is in effect', async () => {
      fleetSizeState.estimate = 4;
      fleetSizeState.source = 'dynamic';
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        rateLimitFleetEstimate: number;
        rateLimitFleetEstimateSource: string;
      };
      expect(body.status).toBe('healthy');
      expect(body.rateLimitFleetEstimate).toBe(4);
      expect(body.rateLimitFleetEstimateSource).toBe('dynamic');
    });

    it('reports the static fallback + source when no live DNS read is in effect', async () => {
      fleetSizeState.estimate = 2;
      fleetSizeState.source = 'static';
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      const body = (await res.json()) as {
        rateLimitFleetEstimate: number;
        rateLimitFleetEstimateSource: string;
      };
      expect(body.rateLimitFleetEstimate).toBe(2);
      expect(body.rateLimitFleetEstimateSource).toBe('static');
    });

    it('does not affect softDegraded/criticalDegraded/status — purely informational', async () => {
      fleetSizeState.estimate = 1;
      fleetSizeState.source = 'static';
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        softDegraded: boolean;
        criticalDegraded: boolean;
        softDegradedReasons: string[];
      };
      expect(body.status).toBe('healthy');
      expect(body.softDegraded).toBe(false);
      expect(body.criticalDegraded).toBe(false);
      expect(body.softDegradedReasons).toEqual([]);
    });
  });

  // go-live-plan §T1-F: GeoLite2 staleness/absence signal. Pins the
  // three-way distinction in `GeoDbStatus.stale` (public/geo.ts) —
  // "unconfigured" must read as healthy/quiet, "stale" and
  // "configured-but-unopenable" must both soft-degrade + eventually page.
  describe('geo db staleness', () => {
    it('does not soft-degrade when MAXMIND_GEOLITE2_PATH was never configured', async () => {
      // geoDbState defaults to the "unconfigured" shape (see beforeEach).
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        geoDbStale: boolean;
        geoDbBuildEpoch: string | null;
        softDegradedReasons: string[];
      };
      expect(body.status).toBe('healthy');
      expect(body.geoDbStale).toBe(false);
      expect(body.geoDbBuildEpoch).toBeNull();
      expect(body.softDegradedReasons).not.toContain('geo_db_stale');
      expect(notifyGeoDbStaleMock).not.toHaveBeenCalled();
    });

    it('soft-degrades (200, not 503) and reports geoDbBuildEpoch when the db is stale', async () => {
      geoDbState.available = true;
      geoDbState.buildEpoch = '2026-01-01T00:00:00.000Z';
      geoDbState.ageDays = 100;
      geoDbState.stale = true;

      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        geoDbStale: boolean;
        geoDbBuildEpoch: string | null;
        softDegraded: boolean;
        criticalDegraded: boolean;
        softDegradedReasons: string[];
      };
      expect(body.status).toBe('degraded');
      expect(body.geoDbStale).toBe(true);
      expect(body.geoDbBuildEpoch).toBe('2026-01-01T00:00:00.000Z');
      expect(body.softDegraded).toBe(true);
      expect(body.criticalDegraded).toBe(false);
      expect(body.softDegradedReasons).toContain('geo_db_stale');
    });

    it('soft-degrades with a null buildEpoch when the path is configured but the db failed to open', async () => {
      geoDbState.available = false;
      geoDbState.buildEpoch = null;
      geoDbState.ageDays = null;
      geoDbState.stale = true;

      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      const body = (await res.json()) as { geoDbStale: boolean; geoDbBuildEpoch: string | null };
      expect(body.geoDbStale).toBe(true);
      expect(body.geoDbBuildEpoch).toBeNull();
    });

    it('gates notifyGeoDbStale to a 7-day cooldown, then re-fires once the cooldown elapses', async () => {
      geoDbState.available = true;
      geoDbState.buildEpoch = '2026-01-01T00:00:00.000Z';
      geoDbState.ageDays = 100;
      geoDbState.stale = true;

      const first = makeCtx();
      await healthHandler(first.ctx);
      expect(notifyGeoDbStaleMock).toHaveBeenCalledTimes(1);
      expect(notifyGeoDbStaleMock).toHaveBeenCalledWith({
        buildEpoch: '2026-01-01T00:00:00.000Z',
        ageDays: 100,
        thresholdDays: 45,
      });

      // Condition still persists on the very next probe — cooldown
      // withholds the repage so a sustained "forgot to redeploy" state
      // doesn't spam the channel every request.
      const second = makeCtx();
      await healthHandler(second.ctx);
      expect(notifyGeoDbStaleMock).toHaveBeenCalledTimes(1);

      // Jump past the 7-day cooldown window.
      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 7 * 24 * 60 * 60 * 1000 + 1);
      try {
        const third = makeCtx();
        await healthHandler(third.ctx);
        expect(notifyGeoDbStaleMock).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
