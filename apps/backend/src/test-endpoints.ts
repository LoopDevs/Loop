/**
 * Test-only HTTP surface mounted on the long-lived backend
 * process under `NODE_ENV=test`. Pulled out of `app.ts` so the
 * test-harness mount logic + its rationale don't sit in the
 * middle of the route table.
 *
 * Why this exists at all:
 *
 * Mocked e2e tests run against this process as a long-lived
 * server — each test spawns a fresh browser context but hits the
 * same backend. Per-IP rate-limit state accumulates across tests:
 * a single IP exercising `/api/auth/request-otp` across multiple
 * tests + Playwright retries will blow through the 5/min budget
 * and start seeing 429, which manifests as a disabled Continue
 * button that never re-enables (the UI sees the 429 as a network
 * error and leaves auth-loading stuck in its cleanup path).
 *
 * `POST /__test__/reset` exposes a reset hook for the mocked
 * suite's `beforeEach` to call. The endpoint is deliberately
 * outside the `/api` namespace so it doesn't appear in the
 * OpenAPI spec and the lint-docs "route must be in
 * architecture.md" check leaves it alone.
 *
 * The mount is gated on `env.NODE_ENV === 'test'` from
 * `app.ts`'s `mountTestEndpoints` call site so production can't
 * be nudged into dropping the limiter. The unit-test rate-limit
 * coverage (see `routes.integration.test.ts`) imports
 * `__resetRateLimitsForTests` directly and isn't affected by
 * this endpoint.
 */
import type { Hono } from 'hono';
import { __resetRateLimitsForTests } from './middleware/rate-limit.js';
import { __resetUpstreamProbeCacheOnlyForTests } from './health.js';

/**
 * Mount the `/__test__/*` surface on the supplied Hono app.
 * Caller should gate on `env.NODE_ENV === 'test'` — this function
 * is unconditional so a misconfigured test setup can't silently
 * skip the mount.
 */
export function mountTestEndpoints(app: Hono): void {
  app.post('/__test__/reset', (c) => {
    __resetRateLimitsForTests();
    __resetUpstreamProbeCacheOnlyForTests();
    return c.json({ message: 'reset' });
  });
}
