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
 * AUDIT-2-E defense-in-depth: `app.ts` already gates the *call
 * site* on `env.NODE_ENV === 'test'`, but that's a single string
 * compare — a misconfigured staging/preview deploy that copies
 * `NODE_ENV=test` (docker-compose override, debug deploy, etc.)
 * would otherwise expose `/__test__/mint-loop-token` — a
 * zero-credential-check session minter — to the internet. This
 * module re-asserts `NODE_ENV === 'test'` itself (so it's safe even
 * if some future refactor calls `mountTestEndpoints` from a
 * different site) AND requires a second, independent control:
 * `env.LOOP_TEST_ENDPOINTS_SECRET` must be configured, and every
 * request under `/__test__/*` must present the matching value via
 * the `X-Test-Endpoints-Secret` header. If the secret env var isn't
 * set, NEITHER route mounts — same as if this function were never
 * called at all — so `NODE_ENV=test` alone is never sufficient to
 * reach this surface. A mismatched/missing header 404s rather than
 * 401/403, so a probe can't distinguish "wrong secret" from "route
 * doesn't exist" (production's actual posture).
 */
import type { Context, Hono, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from './env.js';
import { __resetRateLimitsForTests } from './middleware/rate-limit.js';
import { __resetUpstreamProbeCacheOnlyForTests } from './health.js';
import { findOrCreateUserByEmail } from './db/users.js';
import { issueTokenPair } from './auth/issue-token-pair.js';

const SECRET_HEADER = 'x-test-endpoints-secret';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched-length buffers — fall back to
  // a plain (non-constant-time) `false` for that case. The lengths
  // themselves aren't secret (the header value length is visible to
  // any caller who can send requests), so this doesn't reintroduce a
  // meaningful timing side-channel.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Mount the `/__test__/*` surface on the supplied Hono app.
 * Caller should gate on `env.NODE_ENV === 'test'` — this function
 * ALSO re-checks that itself (see module doc comment) and requires
 * `env.LOOP_TEST_ENDPOINTS_SECRET` to be configured before mounting
 * anything; a request under `/__test__/*` that omits or mismatches
 * the `X-Test-Endpoints-Secret` header 404s.
 */
export function mountTestEndpoints(app: Hono): void {
  // Belt-and-suspenders: never mount outside a test process, even if
  // this function is somehow invoked from a different call site.
  if (env.NODE_ENV !== 'test') {
    return;
  }

  const secret = env.LOOP_TEST_ENDPOINTS_SECRET;
  if (!secret) {
    // No secret configured — refuse to mount ANYTHING under
    // `/__test__/*`. `NODE_ENV==='test'` must never be sufficient on
    // its own to reach this surface (AUDIT-2-E).
    return;
  }

  const requireSecret = async (c: Context, next: Next): Promise<void | Response> => {
    const supplied = c.req.header(SECRET_HEADER);
    if (!supplied || !safeEqual(supplied, secret)) {
      return c.notFound();
    }
    await next();
    return undefined;
  };

  app.post('/__test__/reset', requireSecret, (c) => {
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
  // gated on NODE_ENV=test + the shared secret above: it creates the
  // user via findOrCreateUserByEmail, mints a real access/refresh
  // token pair, persists the refresh row, and returns both. The test
  // then plants the refresh token in the browser's sessionStorage and
  // lets the existing boot-restore (use-session-restore.ts) refresh
  // the access token through the real flow.
  //
  // findOrCreateUserByEmail's own contract requires callers to only
  // pass a provider/OTP-verified email (see its doc comment in
  // db/users.ts) — this endpoint is the one deliberate, gated
  // exception, and the gate above is what makes that exception safe:
  // reaching this handler at all requires NODE_ENV=test AND knowledge
  // of a secret that's never set outside test infrastructure.
  const MintBody = z.object({
    email: z.string().email().min(1).max(254),
  });
  app.post('/__test__/mint-loop-token', requireSecret, async (c) => {
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
