import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * `/health` had zero test coverage before this file. Added alongside
 * CF2-01 (2026-06-30 cold audit) to protect the new operator-pool
 * exposure, and to close the pre-existing gap while touching this file.
 */

const { locationsState, merchantsState, runtimeState, dbState, operatorHealthMock } = vi.hoisted(
  () => ({
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
  }),
);

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
});
