import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../config/index.js';
import { Hono } from 'hono';

// AUDIT-2-E — drives mountTestEndpoints directly to verify the router's own secret gate, independent of app.ts call-site checks.

const { configState } = vi.hoisted(() => ({
  configState: {
    env: 'test' as 'development' | 'production' | 'test',
    endpointsSecret: undefined as string | undefined,
  },
}));

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        env: configState.env,
        testing: { endpointsSecret: configState.endpointsSecret },
      };
    },
  };
});

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
  configState.env = 'test';
  configState.endpointsSecret = undefined;
});

describe('mountTestEndpoints — AUDIT-2-E secret gate', () => {
  it('404s /__test__/mint-loop-token when the secret env var is unset, even under NODE_ENV=test', async () => {
    configState.env = 'test';
    configState.endpointsSecret = undefined;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('404s /__test__/reset when the secret env var is unset, even under NODE_ENV=test', async () => {
    configState.env = 'test';
    configState.endpointsSecret = undefined;
    const app = buildApp();
    const res = await app.request('/__test__/reset', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('404s when the request omits the X-Test-Endpoints-Secret header', async () => {
    configState.env = 'test';
    configState.endpointsSecret = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/mint-loop-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MINT_BODY,
    });
    expect(res.status).toBe(404);
  });

  it('404s when the request sends a mismatched secret', async () => {
    configState.env = 'test';
    configState.endpointsSecret = SECRET;
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
    configState.env = 'test';
    configState.endpointsSecret = SECRET;
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
    configState.env = 'test';
    configState.endpointsSecret = SECRET;
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
    configState.env = 'test';
    configState.endpointsSecret = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'X-Test-Endpoints-Secret': SECRET },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'reset' });
  });

  it('never mounts under NODE_ENV=production, even with the correct secret set', async () => {
    configState.env = 'production';
    configState.endpointsSecret = SECRET;
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
    configState.env = 'development';
    configState.endpointsSecret = SECRET;
    const app = buildApp();
    const res = await app.request('/__test__/reset', {
      method: 'POST',
      headers: { 'X-Test-Endpoints-Secret': SECRET },
    });
    expect(res.status).toBe(404);
  });
});
