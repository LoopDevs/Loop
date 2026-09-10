import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../config/index.js';
import type { Context } from 'hono';

// CF2-10, S4-4

const { configState } = vi.hoisted(() => ({
  configState: {
    trustProxy: false,
    rateLimitEnabled: true,
  },
}));

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        server: { ...actual.config.server, trustProxy: configState.trustProxy },
        rateLimit: { ...actual.config.rateLimit, enabled: configState.rateLimitEnabled },
      };
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

vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => ({ remote: { address: '203.0.113.1' } }),
}));

const { metricsMock } = vi.hoisted(() => ({
  metricsMock: { incrementRateLimitHit: vi.fn() },
}));
vi.mock('../metrics.js', () => ({
  incrementRateLimitHit: () => metricsMock.incrementRateLimitHit(),
}));

// S4-4: mocked to isolate rateLimit logic from fleet-size estimation
const { fleetSizeState } = vi.hoisted(() => ({
  fleetSizeState: { estimate: 1 },
}));
vi.mock('../middleware/fleet-size.js', () => ({
  currentFleetSizeEstimate: () => fleetSizeState.estimate,
}));

import { rateLimit, globalRateLimit, __resetRateLimitsForTests } from '../middleware/rate-limit.js';

function makeCtx(path = '/api/anything'): { ctx: Context; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const ctx = {
    req: { header: () => undefined, path },
    header: (k: string, v: string) => headers.set(k, v),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
  return { ctx, headers };
}

beforeEach(() => {
  __resetRateLimitsForTests();
  configState.trustProxy = false;
  configState.rateLimitEnabled = true;
  fleetSizeState.estimate = 2;
  metricsMock.incrementRateLimitHit.mockReset();
});

describe('rateLimit middleware', () => {
  it('allows requests under the (machine-count-divided) budget', async () => {
    const mw = rateLimit('test-route-a', 10, 60_000);
    const next = vi.fn(async () => {});
    for (let i = 0; i < 5; i++) {
      const { ctx } = makeCtx();
      const res = await mw(ctx, next);
      expect(res).toBeUndefined();
    }
    expect(next).toHaveBeenCalledTimes(5);
  });

  it('S4-4: divides maxRequests by the current fleet-size estimate before enforcing', async () => {
    fleetSizeState.estimate = 2;
    const mw = rateLimit('test-route-b', 10, 60_000);
    const next = vi.fn(async () => {});
    for (let i = 0; i < 5; i++) {
      const { ctx } = makeCtx();
      await mw(ctx, next);
    }
    const { ctx: ctx6 } = makeCtx();
    const res = await mw(ctx6, next);
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(429);
    expect(next).toHaveBeenCalledTimes(5);
  });

  it('floors the effective budget at 1 rather than 0', async () => {
    fleetSizeState.estimate = 10;
    const mw = rateLimit('test-route-c', 1, 60_000);
    const next = vi.fn(async () => {});
    const { ctx } = makeCtx();
    const res = await mw(ctx, next);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // S4-4: ensures divisor is read per-request, not frozen at factory time
  it("S4-4: reads the fleet-size estimate fresh on every request, not once at the route's creation", async () => {
    fleetSizeState.estimate = 1; // effective budget = 10
    const mw = rateLimit('test-route-live', 10, 60_000);
    const next = vi.fn(async () => {});
    for (let i = 0; i < 3; i++) {
      const { ctx } = makeCtx();
      const res = await mw(ctx, next);
      expect(res).toBeUndefined();
    }
    fleetSizeState.estimate = 5;
    const { ctx } = makeCtx();
    const res = await mw(ctx, next);
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(429);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('sets Retry-After and increments the metrics counter on 429', async () => {
    fleetSizeState.estimate = 1;
    const mw = rateLimit('test-route-d', 1, 60_000);
    const next = vi.fn(async () => {});
    const { ctx: ctx1 } = makeCtx();
    await mw(ctx1, next);
    const { ctx: ctx2, headers } = makeCtx();
    const res = await mw(ctx2, next);
    expect(res?.status).toBe(429);
    expect(headers.get('Retry-After')).toBeDefined();
    expect(metricsMock.incrementRateLimitHit).toHaveBeenCalledTimes(1);
  });

  it('scopes buckets independently per route name (A4-001)', async () => {
    fleetSizeState.estimate = 1;
    const mwA = rateLimit('route-x', 1, 60_000);
    const mwB = rateLimit('route-y', 1, 60_000);
    const next = vi.fn(async () => {});
    const { ctx: ctx1 } = makeCtx();
    await mwA(ctx1, next);
    const { ctx: ctx2 } = makeCtx();
    const res = await mwB(ctx2, next);
    expect(res).toBeUndefined();
  });

  it('bypasses enforcement entirely when DISABLE_RATE_LIMITING is set', async () => {
    configState.rateLimitEnabled = false;
    fleetSizeState.estimate = 1;
    const mw = rateLimit('test-route-e', 1, 60_000);
    const next = vi.fn(async () => {});
    for (let i = 0; i < 5; i++) {
      const { ctx } = makeCtx();
      const res = await mw(ctx, next);
      expect(res).toBeUndefined();
    }
    expect(next).toHaveBeenCalledTimes(5);
  });

  describe('globalRateLimit (hardening B6)', () => {
    it('enforces the generous per-IP ceiling as a volumetric backstop', async () => {
      const mw = globalRateLimit({ maxRequests: 4, windowMs: 60_000 });
      const next = vi.fn(async () => {});
      const a = await mw(makeCtx().ctx, next);
      const b = await mw(makeCtx().ctx, next);
      expect(a).toBeUndefined();
      expect(b).toBeUndefined();
      const c = await mw(makeCtx().ctx, next);
      expect(c).toBeInstanceOf(Response);
      expect((c as Response).status).toBe(429);
    });

    it('exempts /health so the Fly liveness probe is never throttled', async () => {
      const mw = globalRateLimit({ maxRequests: 2, windowMs: 60_000 });
      const next = vi.fn(async () => {});
      for (let i = 0; i < 10; i++) {
        const res = await mw(makeCtx('/health').ctx, next);
        expect(res).toBeUndefined();
      }
      expect(next).toHaveBeenCalledTimes(10);
    });

    it('keys under a distinct namespace — does not consume a per-route budget', async () => {
      const global = globalRateLimit({ maxRequests: 4, windowMs: 60_000 });
      const route = rateLimit('some-route', 4, 60_000); // effective 2 (÷2)
      const next = vi.fn(async () => {});
      await global(makeCtx('/api/x').ctx, next);
      await global(makeCtx('/api/x').ctx, next);
      await global(makeCtx('/api/x').ctx, next); // 429 on global
      const r1 = await route(makeCtx('/api/y').ctx, next);
      const r2 = await route(makeCtx('/api/y').ctx, next);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
    });

    it('is named for the middleware inventory', () => {
      expect(globalRateLimit().name).toBe('globalRateLimit');
    });
  });
});
