import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env before any other imports
vi.mock('../env.js', () => ({
  env: {
    PORT: '8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
    // Mirror zod defaults so the A-036 X-Client-Id allowlist in
    // requireAuth doesn't drop the default values.
    CTX_CLIENT_ID_WEB: 'loopweb',
    CTX_CLIENT_ID_IOS: 'loopios',
    CTX_CLIENT_ID_ANDROID: 'loopandroid',
    // Audit A-023 — rate limiter trusts X-Forwarded-For only when this
    // is true. Integration tests inject XFF values, so enable trust.
    TRUST_PROXY: true,
  },
}));

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock background refresh to prevent timers and network calls
vi.mock('../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

// Mock image proxy eviction
vi.mock('../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

// Mock clustering handler to avoid proto import
vi.mock('../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

// Mock circuit breaker to pass through to global fetch (avoids cross-test state leaks)
vi.mock('../circuit-breaker.js', () => {
  class CircuitOpenError extends Error {
    constructor() {
      super('Circuit breaker is open — upstream service unavailable');
      this.name = 'CircuitOpenError';
    }
  }
  return {
    CircuitOpenError,
    getAllCircuitStates: () => ({}),
    getUpstreamCircuit: () => ({
      fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
      getState: () => 'closed' as const,
      reset: () => {},
    }),
  };
});

import { app } from '../app.js';

// Mock global fetch for upstream proxy calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GET /health', () => {
  it('returns 200 with status healthy when upstream is reachable', async () => {
    // Mock the upstream /status probe
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('locationCount');
    expect(body).toHaveProperty('merchantCount');
    expect(body).toHaveProperty('upstreamReachable');
    expect(body.upstreamReachable).toBe(true);
  });

  it('returns degraded when upstream is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.upstreamReachable).toBe(false);
  });
});

describe('GET /api/merchants', () => {
  it('returns 200 with empty merchant list', async () => {
    const res = await app.request('/api/merchants');
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('merchants');
    expect(Array.isArray(body.merchants)).toBe(true);
  });
});

describe('GET /api/merchants/by-slug/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    const res = await app.request('/api/merchants/by-slug/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/merchants/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/merchants/unknown-id');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/request-otp', () => {
  it('returns 400 for missing email', async () => {
    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 200 when upstream accepts the login request', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'ok' }), { status: 200 }),
    );

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-upstream.local/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns 502 when upstream rejects the login request', async () => {
    mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/auth/verify-otp', () => {
  it('returns 400 for missing fields', async () => {
    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns tokens when upstream verifies successfully', async () => {
    const tokens = { accessToken: 'at-123', refreshToken: 'rt-456' };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens), { status: 200 }));

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', otp: '123456' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accessToken).toBe('at-123');
    expect(body.refreshToken).toBe('rt-456');
  });

  it('returns 401 when upstream rejects the code', async () => {
    mockFetch.mockResolvedValueOnce(new Response('invalid', { status: 401 }));

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', otp: '000000' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('returns 400 for missing refresh token', async () => {
    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns new tokens when upstream accepts refresh', async () => {
    const tokens = { accessToken: 'new-at' };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens), { status: 200 }));

    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'rt-valid' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accessToken).toBe('new-at');
  });
});

describe('GET /api/orders', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/api/orders');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/orders', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/clusters', () => {
  it('returns 200 for cluster requests', async () => {
    const res = await app.request('/api/clusters?west=-100&south=30&east=-90&north=40&zoom=5');
    expect(res.status).toBe(200);
  });
});

describe('app-level middleware', () => {
  it('returns JSON 404 with NOT_FOUND code for unmatched routes', async () => {
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe('NOT_FOUND');
  });

  it('includes Retry-After header when rate-limited', async () => {
    const ip = '203.0.113.42';
    const doReq = (): Promise<Response> | Response =>
      app.request('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email: 'u@example.com' }),
      });

    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    // Burn through the 5/min limit
    for (let i = 0; i < 5; i++) await doReq();

    const limited = await doReq();
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    // Retry-After is seconds; must be a positive integer
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
  });

  it('sets X-Request-Id header on every response', async () => {
    const res = await app.request('/health');
    // requestId middleware generates an id even if the client did not send one
    const id = res.headers.get('X-Request-Id');
    expect(id).not.toBeNull();
    expect(id!.length).toBeGreaterThan(0);
  });

  it('sets a strict Content-Security-Policy on every response', async () => {
    const res = await app.request('/health');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    // API never serves HTML — default-src 'none' forbids every resource
    // class unless we override it, which we do not.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('/openapi.json returns a valid OpenAPI 3.1 spec with our routes', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('Loop API');
    // Sample a handful of endpoints — full coverage is tested at the
    // schema layer; this just confirms the spec actually reaches them.
    expect(body.paths['/health']).toBeDefined();
    expect(body.paths['/api/auth/verify-otp']).toBeDefined();
    expect(body.paths['/api/orders']).toBeDefined();
    expect(body.paths['/api/clusters']).toBeDefined();
    // Bearer auth scheme is registered once and referenced by secured ops.
    expect(body.components.securitySchemes?.bearerAuth).toBeDefined();
  });

  it('/openapi.json is cacheable', async () => {
    const res = await app.request('/openapi.json');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('/metrics exposes Prometheus-format counters and circuit state', async () => {
    // Drive one request through so requestsTotal has an entry, then scrape.
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await app.request('/health');

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('# TYPE loop_rate_limit_hits_total counter');
    expect(body).toContain('# TYPE loop_requests_total counter');
    expect(body).toContain('# TYPE loop_circuit_state gauge');
    // The health request just counted above should appear.
    expect(body).toMatch(/loop_requests_total\{method="GET",route="\/health",status="200"\}/);
  });

  it('/metrics emits exactly one HELP line per metric (audit A-016)', async () => {
    // Prometheus exposition format requires at most one HELP line per
    // metric. We briefly emitted two for loop_circuit_state (one for the
    // description, one for the state-value mapping) which some scrapers
    // rejected. This test locks in the "exactly one" invariant.
    const res = await app.request('/metrics');
    const body = await res.text();
    for (const metric of [
      'loop_rate_limit_hits_total',
      'loop_requests_total',
      'loop_circuit_state',
    ]) {
      const helpLines = body.split('\n').filter((l) => l.startsWith(`# HELP ${metric} `));
      expect(helpLines, `expected exactly one HELP line for ${metric}`).toHaveLength(1);
    }
  });
});
