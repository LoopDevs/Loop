import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * CF2-10 (2026-06-30 cold audit): `rate-limit.ts` had zero dedicated
 * test coverage — only `clientIpFor` was exercised directly (via
 * `trust-proxy.test.ts`), never the `rateLimit()` factory's actual
 * budget-enforcement/429 logic. Added alongside the
 * RATE_LIMIT_MACHINE_COUNT_ESTIMATE stopgap so both the pre-existing
 * behavior and the new machine-count division are locked in.
 */

const { envState } = vi.hoisted(() => ({
  envState: {
    NODE_ENV: 'test' as string,
    TRUST_PROXY: false,
    DISABLE_RATE_LIMITING: false,
    RATE_LIMIT_MACHINE_COUNT_ESTIMATE: 2 as number | undefined,
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

import { rateLimit, __resetRateLimitsForTests } from '../middleware/rate-limit.js';

function makeCtx(): { ctx: Context; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const ctx = {
    req: { header: () => undefined },
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
  envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 2;
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

  it('CF2-10: divides maxRequests by RATE_LIMIT_MACHINE_COUNT_ESTIMATE before enforcing', async () => {
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 2;
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
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 10;
    const mw = rateLimit('test-route-c', 1, 60_000);
    const next = vi.fn(async () => {});
    const { ctx } = makeCtx();
    const res = await mw(ctx, next);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Real bug caught while implementing this fix: many existing test
  // files mock env.js with a hand-picked field subset that predates
  // this var, so RATE_LIMIT_MACHINE_COUNT_ESTIMATE is `undefined` at
  // runtime there despite env.ts's static type claiming it's always a
  // number. Math.floor(max / undefined) = NaN, and count > NaN is
  // permanently false — silently disabling the limiter entirely
  // (5 real test failures across handler.test.ts and
  // routes.integration.test.ts before this fallback was added).
  it('falls back to no division when the estimate is undefined/non-numeric at runtime', async () => {
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = undefined;
    const mw = rateLimit('test-route-f', 2, 60_000);
    const next = vi.fn(async () => {});
    const { ctx: ctx1 } = makeCtx();
    await mw(ctx1, next);
    const { ctx: ctx2 } = makeCtx();
    await mw(ctx2, next);
    const { ctx: ctx3 } = makeCtx();
    const res = await mw(ctx3, next);
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(429);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('sets Retry-After and increments the metrics counter on 429', async () => {
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 1;
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
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 1;
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
    envState.RATE_LIMIT_MACHINE_COUNT_ESTIMATE = 1;
    const mw = rateLimit('test-route-e', 1, 60_000);
    const next = vi.fn(async () => {});
    for (let i = 0; i < 5; i++) {
      const { ctx } = makeCtx();
      const res = await mw(ctx, next);
      expect(res).toBeUndefined();
    }
    expect(next).toHaveBeenCalledTimes(5);
  });
});
