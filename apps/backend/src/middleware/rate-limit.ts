/**
 * Per-IP per-route rate limiter pulled out of `app.ts`. Three
 * exports:
 *
 * - `clientIpFor(c)` — resolves the IP the limiter keys on, with
 *   `env.TRUST_PROXY` deciding whether `X-Forwarded-For` is
 *   trusted (audit A-023, A2-1526). Exported so the trust-proxy
 *   tests can drive the predicate end-to-end without spinning up
 *   a real rate-limited endpoint.
 * - `rateLimit(name, max, windowMs)` — Hono middleware factory.
 *   Returns 429 with `Retry-After` when the per-IP-per-route
 *   budget is exceeded, bumping `incrementRateLimitHit()` so the
 *   counter shows up on `/metrics`. Honours
 *   `env.DISABLE_RATE_LIMITING` as the e2e harness escape hatch.
 * - `__resetRateLimitsForTests()` — clears the in-process map
 *   between vitest cases.
 *
 * **A4-001 — bucket key is `${name}:${ip}`.** Earlier the bucket
 * was keyed on `ip` alone, so a high-budget route (clusters
 * 60/min) burned down the budget for low-budget routes
 * (request-otp 5/min) from the same IP — locking legitimate
 * users out of auth after a handful of map-page polls.
 * The factory now requires an explicit `name` per mount so each
 * (route, ip) pair gets an independent bucket, matching the
 * per-route limits documented in CLAUDE.md / AGENTS.md.
 *
 * The `rateLimitMap` is module-local; `RATE_LIMIT_MAP_MAX = 10_000`
 * caps it so an attacker spraying requests from fresh IPs can't
 * grow the map until OOM. Once at capacity we evict the oldest
 * entry (Map iteration is insertion-order in V8) before inserting
 * — the attacker loses memory of their own earlier hits but the
 * process stays stable.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env.js';
import { incrementRateLimitHit } from '../metrics.js';

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAP_MAX = 10_000;

/**
 * Resolves the client IP the rate limiter should key on. Audit
 * A-023: previously `c.req.header('x-forwarded-for')?.split(',')[0]`
 * was used unconditionally, meaning any client could send an
 * `X-Forwarded-For` with an arbitrary value and bypass per-IP
 * limits by rotating that value.
 *
 * Policy:
 *   - `env.TRUST_PROXY === true`: we're behind a trusted edge
 *     proxy (Fly.io, nginx, Cloud Run, etc.) that writes
 *     X-Forwarded-For. Use the leftmost value — that's the
 *     original client the edge saw.
 *   - `env.TRUST_PROXY === false`: no trusted proxy in front of
 *     us. Use the TCP socket's remote address. Ignores
 *     X-Forwarded-For entirely.
 *
 * Returns the string `'unknown'` only if both sources fail — rate
 * limits still apply but everyone lands in the same bucket, which
 * is conservative.
 */
// A2-1526: exported so `__tests__/trust-proxy.test.ts` can drive
// both TRUST_PROXY=true and TRUST_PROXY=false paths end-to-end
// without having to bring up a real rate-limited endpoint to
// observe the bucketing decision. The rate-limit middleware calls
// this for every request.
export function clientIpFor(c: Context): string {
  if (env.TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff !== undefined && xff.length > 0) {
      const first = xff.split(',')[0]?.trim();
      if (first !== undefined && first.length > 0) return first;
    }
  }
  try {
    const info = getConnInfo(c);
    const address = info.remote.address;
    if (address !== undefined && address.length > 0) return address;
  } catch {
    /* conninfo unavailable — dev server/test harness */
  }
  return 'unknown';
}

/**
 * Test helper: wipe the rate-limit map between cases. Module
 * state persists across `app.request(...)` calls, so a test that
 * exercises the same route many times in a loop will start
 * receiving 429 as soon as it passes the route's per-minute
 * budget. Tests that hit the budget intentionally (the order-
 * validation suite fires dozens of rejections back-to-back) call
 * this from `beforeEach` to reset. Also called from the
 * `/__test__/reset` endpoint that vitest harness uses.
 */
export function __resetRateLimitsForTests(): void {
  rateLimitMap.clear();
}

/**
 * Sweeps expired entries out of the rate-limit map. Called from the
 * hourly cleanup tick in `app.ts`; without this the map would
 * accumulate one stale entry per IP per route forever (until the
 * `RATE_LIMIT_MAP_MAX` cap kicks in and starts evicting on insert).
 */
export function sweepExpiredRateLimits(now: number = Date.now()): void {
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}

/**
 * Per-IP per-route rate limiter. Returns 429 if the budget for
 * `(name, ip)` is exceeded within `windowMs`.
 *
 * **A4-001:** `name` scopes the bucket so each protected route
 * gets an independent counter. Pass a stable identifier per
 * mount; route patterns work fine (`/api/auth/request-otp`,
 * `/api/clusters`, etc.). The map key is `${name}:${ip}`.
 *
 * Conventional naming (recommended): `${METHOD} ${routePattern}`
 * for routes that share a path across methods (e.g. `GET /api/orders/:id`
 * vs `POST /api/orders/:id/retry`).
 */
export function rateLimit(
  name: string,
  maxRequests: number,
  windowMs: number,
): (c: Context, next: () => Promise<void>) => Promise<void | Response> {
  return async (c, next): Promise<void | Response> => {
    // Escape hatch for e2e test runs. The mocked-e2e suite drives
    // the purchase flow twice with Playwright retries, which
    // collides with the 5/min request-otp limit on a cold start.
    // Setting DISABLE_RATE_LIMITING=1 lets the harness bypass the
    // limiter without tripping the unit tests that explicitly
    // verify the 429 path under NODE_ENV=test. Production never
    // sets this flag.
    if (env.DISABLE_RATE_LIMITING) {
      await next();
      return;
    }
    const ip = clientIpFor(c);
    const key = `${name}:${ip}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (entry === undefined || now > entry.resetAt) {
      // Evict the oldest entry if we're at capacity. Map iteration
      // order is insertion order, so keys().next().value is the
      // oldest.
      if (rateLimitMap.size >= RATE_LIMIT_MAP_MAX && entry === undefined) {
        const oldest = rateLimitMap.keys().next().value;
        if (oldest !== undefined) rateLimitMap.delete(oldest);
      }
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > maxRequests) {
        // Tell the client when the window resets so clients can
        // back off instead of hot-looping retries.
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        c.header('Retry-After', String(retryAfterSec));
        incrementRateLimitHit();
        return c.json({ code: 'RATE_LIMITED', message: 'Too many requests' }, 429);
      }
    }

    await next();
  };
}
