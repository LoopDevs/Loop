import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  PORT: '8080',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
  CTX_CLIENT_ID_WEB: 'loopweb',
  CTX_CLIENT_ID_IOS: 'loopios',
  CTX_CLIENT_ID_ANDROID: 'loopandroid',
  REFRESH_INTERVAL_HOURS: 6,
  LOCATION_REFRESH_INTERVAL_HOURS: 24,
}));

vi.mock('../../env.js', () => ({ env: mockEnv }));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

vi.mock('../../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

// Bypass circuit breaker — tests exercise auth handler logic, not circuit semantics.
vi.mock('../../circuit-breaker.js', () => {
  class CircuitOpenError extends Error {
    constructor() {
      super('open');
      this.name = 'CircuitOpenError';
    }
  }
  return {
    CircuitOpenError,
    upstreamCircuit: {
      fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
      getState: () => 'closed' as const,
      reset: () => {},
    },
  };
});

import { app } from '../../app.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> | Response {
  // Unique IP per test so rate-limiter state does not leak between cases.
  const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/request-otp', () => {
  it('rejects missing body with 400', async () => {
    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed email with 400', async () => {
    const res = await post('/api/auth/request-otp', { email: 'not-an-email', platform: 'web' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 200 on upstream success', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await post('/api/auth/request-otp', { email: 'u@example.com', platform: 'web' });
    expect(res.status).toBe(200);
  });

  it('returns 200 on upstream 404 (email enumeration defense)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'no such user' }), { status: 404 }),
    );
    const res = await post('/api/auth/request-otp', {
      email: 'unknown@example.com',
      platform: 'web',
    });
    // Must look identical to a successful request so an attacker cannot enumerate.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.message).toContain('Verification');
  });

  it('returns 502 on upstream 5xx (real infrastructure failure surfaces)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const res = await post('/api/auth/request-otp', { email: 'u@example.com', platform: 'web' });
    expect(res.status).toBe(502);
  });

  it('maps platform ios → CTX_CLIENT_ID_IOS in upstream body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await post('/api/auth/request-otp', { email: 'u@example.com', platform: 'ios' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'u@example.com',
      clientId: 'loopios',
    });
  });

  it('rate limits after 5 requests in a minute from the same IP', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const ip = '203.0.113.55';
    const doReq = (): Promise<Response> | Response =>
      app.request('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: 'u@example.com', platform: 'web' }),
      });

    for (let i = 0; i < 5; i++) {
      const ok = await doReq();
      expect(ok.status).toBe(200);
    }
    const limited = await doReq();
    expect(limited.status).toBe(429);
  });
});

describe('POST /api/auth/verify-otp', () => {
  it('rejects invalid body with 400', async () => {
    const res = await post('/api/auth/verify-otp', {
      email: 'not-email',
      otp: '',
      platform: 'web',
    });
    expect(res.status).toBe(400);
  });

  it('forwards upstream 200 with validated token shape', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'AAA.BBB.CCC', refreshToken: 'r-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await post('/api/auth/verify-otp', {
      email: 'u@example.com',
      otp: '123456',
      platform: 'web',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.accessToken).toBe('AAA.BBB.CCC');
    expect(body.refreshToken).toBe('r-token');
  });

  it('returns 502 when upstream returns unexpected shape', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await post('/api/auth/verify-otp', {
      email: 'u@example.com',
      otp: '123456',
      platform: 'web',
    });
    expect(res.status).toBe(502);
  });

  it('maps upstream 401 → 401 UNAUTHORIZED', async () => {
    mockFetch.mockResolvedValueOnce(new Response('bad code', { status: 401 }));
    const res = await post('/api/auth/verify-otp', {
      email: 'u@example.com',
      otp: '000000',
      platform: 'web',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('rate limits OTP brute-force attempts (10/min per IP)', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 401 }));
    const ip = '203.0.113.77';
    const doReq = (code: string): Promise<Response> | Response =>
      app.request('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: 'u@example.com', otp: code, platform: 'web' }),
      });

    for (let i = 0; i < 10; i++) {
      const r = await doReq(String(100000 + i));
      expect(r.status).toBe(401);
    }
    const limited = await doReq('999999');
    expect(limited.status).toBe(429);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rejects missing refreshToken', async () => {
    const res = await post('/api/auth/refresh', { platform: 'web' });
    expect(res.status).toBe(400);
  });

  it('returns 401 on upstream non-ok (invalid/expired)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('expired', { status: 401 }));
    const res = await post('/api/auth/refresh', {
      refreshToken: 'stale-token',
      platform: 'web',
    });
    expect(res.status).toBe(401);
  });

  it('forwards new tokens on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await post('/api/auth/refresh', { refreshToken: 'r1', platform: 'web' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.accessToken).toBe('new-access');
  });

  it('accepts refresh response without new refreshToken (optional field)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'only-access' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await post('/api/auth/refresh', { refreshToken: 'r1', platform: 'web' });
    expect(res.status).toBe(200);
  });

  it('rate limits 30/min per IP', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 401 }));
    const ip = '203.0.113.99';
    const doReq = (): Promise<Response> | Response =>
      app.request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ refreshToken: 'x', platform: 'web' }),
      });

    for (let i = 0; i < 30; i++) {
      const r = await doReq();
      expect(r.status).toBe(401);
    }
    const limited = await doReq();
    expect(limited.status).toBe(429);
  });
});

describe('requireAuth middleware (via /api/orders)', () => {
  it('rejects missing Authorization header with 401', async () => {
    const res = await app.request('/api/orders');
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed Authorization header (no Bearer prefix)', async () => {
    const res = await app.request('/api/orders', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
  });
});
