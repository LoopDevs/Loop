import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * AUDIT-2-E — coverage for the defense-in-depth gate on the
 * `/__test__/*` surface (`test-endpoints.ts`).
 *
 * Before this fix, the ONLY thing standing between an unauthenticated
 * caller and `/__test__/mint-loop-token` (which mints a full session
 * token pair for any allowlisted email with zero credential check)
 * was a single `env.NODE_ENV === 'test'` string compare at the
 * `app.ts` call site. This suite drives `mountTestEndpoints` directly
 * against a bare Hono app (not the full `app.ts` import graph) with a
 * mutable env mock, so each case can flip `NODE_ENV` /
 * `LOOP_TEST_ENDPOINTS_SECRET` independently and assert the router's
 * own belt-and-suspenders checks — not just the app.ts call site.
 */

const { envState } = vi.hoisted(() => ({
  envState: {
    NODE_ENV: 'test' as string,
    LOOP_TEST_ENDPOINTS_SECRET: undefined as string | undefined,
  },
}));

vi.mock('../env.js', () => ({
  get env() {
    return envState;
  },
}));

vi.mock('../db/users.js', () => ({
  findOrCreateUserByEmail: vi.fn(async (email: string) => ({
    id: 'user-1',
    email,
    isAdmin: false,
  })),
}));

vi.mock('../auth/issue-token-pair.js', () => ({
  issueTokenPair: vi.fn(async () => ({
    accessToken: 'access-token-stub',
    refreshToken: 'refresh-token-stub',
  })),
}));

vi.mock('../middleware/rate-limit.js', () => ({
  __resetRateLimitsForTests: vi.fn(),
}));

vi.mock('../health.js', () => ({
  __resetUpstreamProbeCacheOnlyForTests: vi.fn(),
}));

import { mountTestEndpoints } from '../test-endpoints.js';

const SECRET = 'correct-secret-at-least-16-chars';
const MINT_BODY = JSON.stringify({ email: 'someone@example.com' });

function buildApp(): Hono {
  const app = new Hono();
  mountTestEndpoints(app);
  return app;
}

beforeEach(() => {
  envState.NODE_ENV = 'test';
  envState.LOOP_TEST_ENDPOINTS_SECRET = undefined;
});

describe('mountTestEndpoints — AUDIT-2-E secret gate', () => {
  it('404s /__test__/mint-loop-token when the secret env var is unset, even under NODE_ENV=test', async () => {
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = undefined;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('404s /__test__/reset when the secret env var is unset, even under NODE_ENV=test', async () => {
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = undefined;
    const app = buildApp();
    const res = await app.request('/__test__/reset', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('404s when the request omits the X-Test-Endpoints-Secret header', async () => {
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('404s when the request sends a mismatched secret', async () => {
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Test-Endpoints-Secret': 'wrong-secret-but-also-long-enough',
      },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('404s a mismatched secret of a DIFFERENT length than the configured one', async () => {
    // Exercises the length-mismatch branch of safeEqual (which can't
    // hand mismatched-length buffers to timingSafeEqual).
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Test-Endpoints-Secret': 'short',
      },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('mints a token pair when NODE_ENV=test AND the correct secret is presented', async () => {
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Test-Endpoints-Secret': SECRET,
      },
      body: MINT_BODY,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(body.accessToken).toBe('access-token-stub');
    expect(body.refreshToken).toBe('refresh-token-stub');
  });

  it('resets successfully when NODE_ENV=test AND the correct secret is presented', async () => {
    envState.NODE_ENV = 'test';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'X-Test-Endpoints-Secret': SECRET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'reset' });
  });

  it('never mounts under NODE_ENV=production, even with the correct secret set', async () => {
    envState.NODE_ENV = 'production';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Test-Endpoints-Secret': SECRET,
      },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('never mounts under NODE_ENV=development, even with the correct secret set', async () => {
    envState.NODE_ENV = 'development';
    envState.LOOP_TEST_ENDPOINTS_SECRET = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'X-Test-Endpoints-Secret': SECRET },
    });
    expect(res.status).toBe(404);
  });
});
