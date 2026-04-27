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
import { z } from 'zod';
import { __resetRateLimitsForTests } from './middleware/rate-limit.js';
import { __resetUpstreamProbeCacheOnlyForTests } from './health.js';
import { findOrCreateUserByEmail } from './db/users.js';
import { issueTokenPair } from './auth/issue-token-pair.js';

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

  // A2-1705 phase A.3: test-only loop-native session minter.
  //
  // The mocked-e2e harness can't drive the real OTP flow against the
  // loop-native auth path because there's no inbox to scrape; the
  // legacy CTX-proxy path uses a fixed OTP fixture in mock-CTX, but
  // the loop-native path mints OTPs against postgres. Rather than
  // teach Playwright to read the otps table (or hot-wire a fixed-OTP
  // backdoor into the production flow), we expose this endpoint
  // gated on NODE_ENV=test: it creates the user via
  // findOrCreateUserByEmail, mints a real access/refresh token pair,
  // persists the refresh row, and returns both. The test then plants
  // the refresh token in the browser's sessionStorage and lets the
  // existing boot-restore (use-session-restore.ts) refresh the
  // access token through the real flow.
  //
  // No different from the existing /__test__/reset gate — production
  // mounts neither.
  const MintBody = z.object({
    email: z.string().email().min(1).max(254),
  });
  app.post('/__test__/mint-loop-token', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = MintBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.format() }, 400);
    }
    const user = await findOrCreateUserByEmail(parsed.data.email);
    const pair = await issueTokenPair({ id: user.id, email: user.email });
    return c.json({
      userId: user.id,
      email: user.email,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    });
  });
}
