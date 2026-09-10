import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ConfigModule from '../config/index.js';
import type { Context } from 'hono';

// /health coverage — CF2-01

const {
  locationsState,
  merchantsState,
  runtimeState,
  dbState,
  ctxApiHealthMock,
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
  ctxApiHealthMock: vi.fn(() => ({ configured: true, state: 'closed' })),
  // Baseline must not spuriously soft-degrade / page
  geoDbState: {
    available: false,
    buildEpoch: null as string | null,
    ageDays: null as number | null,
    stale: false,
  },
  notifyGeoDbStaleMock: vi.fn(),
  // S4-4: baseline must not spuriously imply a live DNS read is in effect
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

// CONV-WATCH-02: gate mocked so transition doesn't touch DB; end-to-end covered in __tests__/integration/health-change-dedup.test.ts
const applyBinaryWatchdogAlertMock = vi.hoisted(() =>
  vi.fn<
    (args: {
      watchdogName: string;
      shouldBeActive: boolean;
      notifyActive: () => Promise<boolean>;
      notifyRecovered: () => Promise<boolean>;
    }) => Promise<boolean>
  >(async () => true),
);
vi.mock('../discord/watchdog-alert.js', () => ({
  applyBinaryWatchdogAlert: applyBinaryWatchdogAlertMock,
}));

// Spy on raw webhook send to observe DB-down fallback (un-deduped send when gate throws)
const sendWebhookSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../discord/shared.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, sendWebhook: sendWebhookSpy };
});

vi.mock('../public/geo.js', () => ({
  getGeoDbStatus: () => Promise.resolve(geoDbState),
  GEO_DB_STALE_AFTER_DAYS: 45,
}));

vi.mock('../middleware/fleet-size.js', () => ({
  currentFleetSizeEstimate: () => fleetSizeState.estimate,
  currentFleetSizeSource: () => fleetSizeState.source,
}));

vi.mock('../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `https://upstream.example.com${path}`,
}));

// Stub db.collection('users').count({}) so dbState.shouldFail drives unreachable branch without a store
vi.mock('../db/client.js', () => ({
  db: {
    collection: () => ({
      count: async () => {
        if (dbState.shouldFail) throw new Error('db down');
        return 0;
      },
    }),
  },
}));

vi.mock('../ctx/api-fetch.js', () => ({
  getCtxApiHealth: ctxApiHealthMock,
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
  ctxApiHealthMock.mockReset().mockReturnValue({ configured: true, state: 'closed' });
  fetchMock.mockReset().mockResolvedValue(new Response('ok', { status: 200 }));
  geoDbState.available = false;
  geoDbState.buildEpoch = null;
  geoDbState.ageDays = null;
  geoDbState.stale = false;
  notifyGeoDbStaleMock.mockReset();
  fleetSizeState.estimate = 1;
  fleetSizeState.source = 'static';
  applyBinaryWatchdogAlertMock.mockReset().mockResolvedValue(true);
  sendWebhookSpy.mockReset().mockResolvedValue(true);
  __resetHealthProbeCacheForTests();
  __resetDbProbeCacheForTests();
});

// DB probe caches for 10s; cache cleared before each degraded probe so toggled dbState is observed
async function driveHealthTransitionToDegraded(): Promise<void> {
  dbState.shouldFail = false;
  __resetDbProbeCacheForTests();
  await healthHandler(makeCtx().ctx);
  dbState.shouldFail = true;
  for (let i = 0; i < 5; i++) {
    __resetDbProbeCacheForTests();
    await healthHandler(makeCtx().ctx);
  }
}

describe('healthHandler', () => {
  it('200 healthy when everything is up', async () => {
    const { ctx } = makeCtx();
    const res = await healthHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ctxApi: unknown;
      ctxApiDown: boolean;
      softDegradedReasons: string[];
    };
    expect(body.status).toBe('healthy');
    expect(body.ctxApi).toEqual({ configured: true, state: 'closed' });
    expect(body.ctxApiDown).toBe(false);
    expect(body.softDegradedReasons).not.toContain('ctx_api_down');
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

  // CONV-WATCH-02: page must route through fleet-wide dedup gate, not per-process notify
  describe('health-change fleet dedup (CONV-WATCH-02)', () => {
    it('routes the healthy→degraded page through the fleet-wide dedup gate', async () => {
      await driveHealthTransitionToDegraded();
      expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledTimes(1);
      expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({ watchdogName: 'health-change', shouldBeActive: true }),
      );
    });

    it('passes the gate a delivery-confirming degraded notifier (fleet at-least-once contract)', async () => {
      await driveHealthTransitionToDegraded();
      const arg = applyBinaryWatchdogAlertMock.mock.calls[0]![0];
      // Gate latches alert_active only on confirmed (true) delivery
      expect(typeof arg.notifyActive).toBe('function');
      expect(typeof arg.notifyRecovered).toBe('function');
      await expect(arg.notifyActive()).resolves.toEqual(expect.any(Boolean));
    });

    // If gate throws (DB down), page must not be dropped — fall back to direct un-deduped send
    it('falls back to a direct send when the dedup gate throws (DB-down incident still pages)', async () => {
      applyBinaryWatchdogAlertMock.mockRejectedValue(new Error('db unreachable'));
      await driveHealthTransitionToDegraded();
      // Let the fire-and-forget .catch fallback settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(sendWebhookSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ctxApiDown can no longer become true; pins fields read by TreasurySnapshot and admin UI
  describe('CTX upstream exposure', () => {
    it('surfaces the credential state in the response body', async () => {
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      const body = (await res.json()) as { ctxApi: { configured: boolean; state: string } };
      expect(body.ctxApi).toEqual({ configured: true, state: 'closed' });
    });

    it('never flags ctxApiDown', async () => {
      const { ctx } = makeCtx();
      const res = await healthHandler(ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ctxApiDown: boolean; softDegradedReasons: string[] };
      expect(body.ctxApiDown).toBe(false);
      expect(body.softDegradedReasons).not.toContain('ctx_api_down');
    });
  });

  it('sets Cache-Control: no-store', async () => {
    const { ctx, headers } = makeCtx();
    await healthHandler(ctx);
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  // S4-4: informational exposure of rate limiter fleet-size divisor; neither field affects status
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

  // go-live-plan §T1-F: GeoLite2 staleness/absence signal
  describe('geo db staleness', () => {
    it('does not soft-degrade when MAXMIND_GEOLITE2_PATH was never configured', async () => {
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

      // Cooldown withholds repage so sustained state doesn't spam channel
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

// BK-healthrecon: /health leaked operational snapshot to unauthenticated callers; fix gates detail behind ops-probe bearer
describe('BK-healthrecon: probe-gated /health body', () => {
  const TOKEN = 'a'.repeat(32);

  async function loadGatedHealthHandler(): Promise<(c: Context) => Promise<Response>> {
    vi.resetModules();
    vi.doMock('../config/index.js', async (importActual) => {
      const actual = await importActual<typeof ConfigModule>();
      return {
        ...actual,
        config: {
          ...actual.config,
          env: 'production',
          observability: {
            ...actual.config.observability,
            metrics: { bearerToken: TOKEN },
          },
        },
      };
    });
    vi.doMock('../logger.js', () => ({
      logger: {
        child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      },
    }));
    const mod = await import('../health.js');
    return mod.healthHandler;
  }

  function makeReqCtx(authorization: string | undefined): {
    ctx: Context;
    headers: Map<string, string>;
  } {
    const headers = new Map<string, string>();
    const ctx = {
      req: { header: (name: string) => (name === 'Authorization' ? authorization : undefined) },
      header: (k: string, v: string) => headers.set(k, v),
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context;
    return { ctx, headers };
  }

  const RECON_FIELDS = [
    'ctxApi',
    'ctxApiDown',
    'workers',
    'otpDelivery',
    'rateLimitFleetEstimate',
    'rateLimitFleetEstimateSource',
    'databaseReachable',
    'upstreamReachable',
    'softDegradedReasons',
    'softDegraded',
    'criticalDegraded',
    'merchantCount',
    'locationCount',
    'geoDbBuildEpoch',
  ] as const;

  afterEach(() => {
    vi.doUnmock('../config/index.js');
    vi.doUnmock('../logger.js');
    vi.resetModules();
  });

  it('reduces the UNAUTHENTICATED response to a minimal liveness signal (no recon detail)', async () => {
    const healthHandlerGated = await loadGatedHealthHandler();
    const { ctx, headers } = makeReqCtx(undefined); // no Authorization header

    const res = await healthHandlerGated(ctx);

    // Fly still gets its liveness signal: the 200/503 and the status word.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('healthy');

    // …but none of the operational reconnaissance fields.
    for (const field of RECON_FIELDS) {
      expect(body).not.toHaveProperty(field);
    }
    // The minimal body is exactly `{ status }` — nothing else rides along.
    expect(Object.keys(body)).toEqual(['status']);

    // Still uncacheable, and now varies on Authorization since the body
    // shape depends on the bearer.
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Vary')).toBe('Authorization');
  });

  it('still returns the full detailed snapshot to an AUTHENTICATED ops caller', async () => {
    const healthHandlerGated = await loadGatedHealthHandler();
    const { ctx } = makeReqCtx(`Bearer ${TOKEN}`);

    const res = await healthHandlerGated(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('healthy');
    // The bearer unlocks the detail — proves the fix gates, not deletes.
    for (const field of RECON_FIELDS) {
      expect(body).toHaveProperty(field);
    }
  });
});
