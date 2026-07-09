import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * CF2-10 (2026-06-30 cold audit): `rate-limit.ts` had zero dedicated
 * test coverage — only `clientIpFor` was exercised directly (via
 * `trust-proxy.test.ts`), never the `rateLimit()` factory's actual
 * budget-enforcement/429 logic. Added alongside the
 * RATE_LIMIT_MACHINE_COUNT_ESTIMATE stopgap so both the pre-existing
 * behavior and the machine-count division are locked in.
 *
 * S4-4 (2026-07-09): the divisor's SOURCE moved to a dynamic fleet-size
 * estimate (`middleware/fleet-size.ts`, unit-tested on its own in
 * `fleet-size.test.ts` — DNS reads, grace period, clamping, the static
 * fallback's defensiveness). This file mocks that module to a plain
 * controllable number so the tests here stay focused on what
 * `rateLimit()` itself is responsible for: applying the divisor
 * correctly, per request, to the budget/429 logic.
 */

const { envState } = vi.hoisted(() => ({
  envState: {
    NODE_ENV: 'test' as string,
    TRUST_PROXY: false,
    DISABLE_RATE_LIMITING: false,
  },
}));

vi.mock('../env.js', () => ({
  get env() {
    return envState;
  },
}));

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

// S4-4: the fleet-size estimator is unit-tested on its own
// (`fleet-size.test.ts` covers DNS/grace-period/clamping behaviour in
// isolation) — here it's mocked so these tests keep exercising exactly
// what they did before the dynamic-estimate wiring (a plain numeric
// divisor), plus a couple of tests below that lock in that the divisor
// is read fresh per-request rather than frozen at factory time.
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
  envState.TRUST_PROXY = false;
  envState.DISABLE_RATE_LIMITING = false;
  fleetSizeState.estimate = 2;
  metricsMock.incrementRateLimitHit.mockReset();
});

describe('rateLimit middleware', () => {
  it('allows requests under the (machine-count-divided) budget', async () => {
    // maxRequests=10, estimate=2 → effective budget 5.
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
    // Effective budget is 10/2 = 5 — the 6th request in the window must 429.
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
    // maxRequests=1, estimate=10 → naive division would be 0, which
    // would reject every single request including the first.
    fleetSizeState.estimate = 10;
    const mw = rateLimit('test-route-c', 1, 60_000);
    const next = vi.fn(async () => {});
    const { ctx } = makeCtx();
    const res = await mw(ctx, next);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // S4-4: this is the wiring bug the dynamic-estimate fix had to avoid
  // reintroducing. Before this fix, `rateLimit()` computed the
  // machine-count divisor ONCE at factory-creation time (i.e. once per
  // route, at app boot) and closed over it forever — fine for a static
  // env var that never changes for the life of the process, but wrong
  // once the divisor is a live fleet-size estimate that changes while
  // the process runs. This test creates the middleware once (like a
  // route mount does) and changes the estimate BETWEEN requests,
  // proving the effective budget is recomputed on every call rather
  // than frozen at creation.
  it("S4-4: reads the fleet-size estimate fresh on every request, not once at the route's creation", async () => {
    fleetSizeState.estimate = 1; // effective budget = 10
    const mw = rateLimit('test-route-live', 10, 60_000);
    const next = vi.fn(async () => {});
    for (let i = 0; i < 3; i++) {
      const { ctx } = makeCtx();
      const res = await mw(ctx, next);
      expect(res).toBeUndefined();
    }
    // Fleet scales up mid-process — effective budget drops to 10/5=2,
    // and the 3 requests already consumed this window must count
    // against the NEW effective budget, tripping the 429 immediately.
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
    // Same IP, different route name — must not share a bucket.
    const { ctx: ctx2 } = makeCtx();
    const res = await mwB(ctx2, next);
    expect(res).toBeUndefined();
  });

  it('bypasses enforcement entirely when DISABLE_RATE_LIMITING is set', async () => {
    envState.DISABLE_RATE_LIMITING = true;
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
      // maxRequests=4, estimate=2 → effective 2 (kept tiny for the test).
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
      // Well past the ceiling — every /health call must still pass.
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
      // Exhaust the global backstop on one path...
      await global(makeCtx('/api/x').ctx, next);
      await global(makeCtx('/api/x').ctx, next);
      await global(makeCtx('/api/x').ctx, next); // 429 on global
      // ...the per-route limiter for a different route is untouched.
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
