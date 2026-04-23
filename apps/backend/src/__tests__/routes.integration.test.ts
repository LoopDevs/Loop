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

// Mock Discord notifiers so the health-change tests can observe the
// flap-damping behavior via call counts without hitting a webhook.
const mockNotifyHealthChange = vi.hoisted(() => vi.fn());
vi.mock('../discord.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, notifyHealthChange: mockNotifyHealthChange };
});

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

import {
  app,
  __resetHealthProbeCacheForTests,
  __resetUpstreamProbeCacheOnlyForTests,
} from '../app.js';

// Mock global fetch for upstream proxy calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockNotifyHealthChange.mockReset();
  // /health caches the upstream reachability probe for 10s so external
  // spammers don't turn into an outbound fetch amplifier. Invalidate the
  // cache between cases so the reachable→unreachable transition is
  // observable inside a single test run. Also resets the hysteresis
  // streak counters + notify cooldown so each test case starts from a
  // known state.
  __resetHealthProbeCacheForTests();
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

  it('sets Cache-Control: no-store so a CDN in front cannot mask an outage', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('caches the upstream probe so bursts of /health do not amplify outbound traffic', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

    // First call triggers a probe; next 4 within the TTL should reuse it.
    await app.request('/health');
    await app.request('/health');
    await app.request('/health');
    await app.request('/health');
    await app.request('/health');

    // The upstream status probe calls go through mockFetch; requireAuth
    // and other handlers don't run for /health, so every fetch call is
    // the probe. Exactly one probe should have fired for 5 inbound calls.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ─── flap damping ─────────────────────────────────────────────────
  // The Fly healthcheck hits /health every 15s with a 10s probe cache,
  // so ~one fresh upstream probe per check. A CTX /status that briefly
  // runs slow used to flip lastHealthStatus on every probe and spam
  // the monitoring channel every minute. These tests verify the
  // asymmetric streak gating + cooldown wrapper introduced in the
  // flap-damping fix. `__resetUpstreamProbeCacheOnlyForTests` drops the
  // probe cache between calls *without* clearing the streak state, so
  // we can drive consecutive transitions inside one test.

  it('body always reflects raw reading — Fly liveness must not be debounced', async () => {
    // First-ever call on a fresh process: the bootstrap seeds
    // lastHealthStatus silently (no notify), but the response body
    // still reports the raw reading so Fly can act on it.
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    const res = await app.request('/health');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded');
    expect(mockNotifyHealthChange).not.toHaveBeenCalled();
  });

  it('single failed probe after healthy does not fire the degraded notify', async () => {
    // Seed healthy
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await app.request('/health');
    expect(mockNotifyHealthChange).not.toHaveBeenCalled();

    // One failed probe — streak = 1, below HEALTH_FLIP_TO_DEGRADED_STREAK.
    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    const res = await app.request('/health');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded'); // raw reading surfaces
    expect(mockNotifyHealthChange).not.toHaveBeenCalled(); // but no page
  });

  it('two consecutive failed probes fire the degraded notify once', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 })); // seed healthy
    await app.request('/health');

    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health');
    expect(mockNotifyHealthChange).not.toHaveBeenCalled(); // streak=1

    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health');
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1); // streak=2 → fires
    expect(mockNotifyHealthChange).toHaveBeenCalledWith('degraded', expect.any(String));
  });

  it('two consecutive successes are NOT enough to flip back to healthy (asymmetric)', async () => {
    // Seed into degraded via two failures
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await app.request('/health');
    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health');
    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health');
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1); // degraded fired

    // Two recoveries — should NOT flip back (threshold is 3)
    for (let i = 0; i < 2; i += 1) {
      __resetUpstreamProbeCacheOnlyForTests();
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await app.request('/health');
    }
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1); // still 1 — no healthy fire yet
  });

  it('three consecutive successes after degraded flip back to healthy', async () => {
    // Drive into degraded
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await app.request('/health');
    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health');
    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health');
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1);

    // But notify cooldown is 5min, so the subsequent healthy flip
    // would normally get throttled. Drop the cooldown clock by
    // recycling the full test-reset once we've verified the degraded
    // fire above. The streak test of the flip-back is what we want
    // to cover here.
    __resetHealthProbeCacheForTests();
    mockNotifyHealthChange.mockReset();

    // Drive into healthy — needs the degraded state first to have
    // somewhere to flip FROM, then 3 healthy readings.
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health'); // bootstrap to degraded
    __resetUpstreamProbeCacheOnlyForTests();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    await app.request('/health'); // streak=1 degraded (no fire — bootstrap already set it)
    // Actually: after reset, first call seeds lastHealthStatus=degraded
    // silently, then subsequent degraded readings just increment the
    // (redundant) streak without firing. We need 3 healthy in a row.
    for (let i = 0; i < 3; i += 1) {
      __resetUpstreamProbeCacheOnlyForTests();
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await app.request('/health');
    }
    expect(mockNotifyHealthChange).toHaveBeenCalledWith('healthy', expect.any(String));
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
    // Auth-gated: proxies CTX with the user's bearer to enrich the
    // cached merchant with long-form content. Supply a dummy bearer
    // so requireAuth passes; the handler's cached-not-found branch
    // then returns 404 before any upstream call.
    const res = await app.request('/api/merchants/unknown-id', {
      headers: { Authorization: 'Bearer test-token' },
    });
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

  it('/metrics labels unmatched routes as NOT_FOUND (audit A-022)', async () => {
    // Hit several random paths. Without the fix, each distinct path would
    // create a separate metric key and balloon cardinality; with the fix,
    // all of them collapse into a single {route="NOT_FOUND"} series.
    await app.request('/fuzz-path-1');
    await app.request('/fuzz-path-2');
    await app.request('/fuzz-path-3?q=abc');
    await app.request('/api/totally-made-up-endpoint');

    const res = await app.request('/metrics');
    const body = await res.text();

    // No raw paths leak into label space.
    for (const path of [
      '/fuzz-path-1',
      '/fuzz-path-2',
      '/fuzz-path-3',
      '/api/totally-made-up-endpoint',
    ]) {
      expect(body).not.toContain(`route="${path}"`);
    }
    // All unmatched traffic lands on the single constant label.
    expect(body).toMatch(
      /loop_requests_total\{method="GET",route="NOT_FOUND",status="404"\} [1-9]/,
    );
  });

  it('/metrics exposes Prometheus-format counters and circuit state', async () => {
    // Drive one request through so requestsTotal has an entry, then scrape.
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await app.request('/health');

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    // Live counter values — a cache in front must not serve a stale
    // scrape to the next collector.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
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
