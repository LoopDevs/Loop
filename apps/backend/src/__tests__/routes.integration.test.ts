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

// A4-034: /health now SELECT 1's the DB. Mock db.execute so the
// integration suite (which has no live Postgres) sees a happy
// probe by default; individual tests can override via the
// dbExecuteMock if they want to exercise the degraded path.
const dbExecuteMock = vi.hoisted(() => vi.fn(async () => [{ '?column?': 1 }]));
vi.mock('../db/client.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    db: {
      execute: dbExecuteMock,
    },
  };
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

// Mock circuit breaker to pass through to global fetch (avoids cross-test state leaks).
// A2-1305: also mirror the production circuit-breaker's CTX-request-id
// capture so the X-Ctx-Request-Id round-trip integration test can
// exercise the full middleware chain. Production circuit-breaker
// reads the response's X-Request-Id (or X-Correlation-Id fallback)
// and writes it onto the per-request AsyncLocalStorage store via
// setCtxResponseRequestId — mirror that here so the integration
// scope sees the same end-to-end behaviour as production.
vi.mock('../circuit-breaker.js', async () => {
  const { setCtxResponseRequestId } = await import('../request-context.js');
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
      fetch: async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
        const response = await globalThis.fetch(...args);
        const ctxId =
          response.headers.get('X-Request-Id') ?? response.headers.get('X-Correlation-Id');
        if (ctxId !== null && ctxId.length > 0) {
          setCtxResponseRequestId(ctxId);
        }
        return response;
      },
      getState: () => 'closed' as const,
      reset: () => {},
    }),
  };
});

import {
  app,
  __resetHealthProbeCacheForTests,
  __resetRateLimitsForTests,
  __resetUpstreamProbeCacheOnlyForTests,
} from '../app.js';
import {
  __resetRuntimeHealthForTests,
  markWorkerStarted,
  markWorkerTickSuccess,
  recordOtpSendFailure,
  recordOtpSendSuccess,
} from '../runtime-health.js';

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
  __resetRuntimeHealthForTests();
  // A2-1005 body-limit tests need a clean per-IP counter; generally
  // safer to reset between every case so rate-limit state doesn't
  // bleed across describe blocks.
  __resetRateLimitsForTests();
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

  it('flap-fix: upstream-only degradation reports degraded but stays HTTP 200', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    const res = await app.request('/health');
    // Soft degradation (CTX `/status` slow / unreachable) used to
    // flip the HTTP status to 503 → Fly cycled the machine → fresh
    // process state → next transition fired Discord again. The fix
    // is to keep the body's `degraded` for visibility but NOT cycle
    // the machine on upstream-only issues.
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.upstreamReachable).toBe(false);
    expect(body.softDegraded).toBe(true);
    expect(body.criticalDegraded).toBe(false);
    expect(body.softDegradedReasons).toEqual(expect.arrayContaining(['upstream_unreachable']));
  });

  it('surfaces OTP delivery degradation in /health with HTTP 503', async () => {
    recordOtpSendFailure(new Error('provider down'));
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await app.request('/health');
    // A4-035 / A4-073: a degraded OTP-delivery surface counts as
    // a degraded backend; orchestrator sees 503.
    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      status: string;
      otpDelivery: { degraded: boolean; lastError: string | null };
      workers: unknown[];
    };
    expect(body.status).toBe('degraded');
    expect(body.otpDelivery.degraded).toBe(true);
    expect(body.otpDelivery.lastError).toBe('provider down');
    expect(Array.isArray(body.workers)).toBe(true);
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
  // the monitoring channel every minute. These tests exercise the
  // rolling-window detector that replaced the consecutive-streak
  // detector — a supermajority of last-10 readings decides the state,
  // so one-off slow probes are absorbed without a transition. Thresholds
  // are asymmetric: 5-of-10 degraded trips the alarm (~2–3 min of
  // persistent badness), 8-of-10 healthy is needed to flip back.

  // `__resetUpstreamProbeCacheOnlyForTests` drops the probe cache
  // between calls *without* clearing the window, so a single test
  // can drive a sequence of transitions.
  //
  // Flap-fix follow-up: the rolling-window detector now keys on
  // criticalDegraded (DB / runtime) only — upstream-only blips no
  // longer rotate the window. We simulate critical degradation by
  // toggling OTP-delivery state, advancing `Date.now()` between
  // calls so the success/failure timestamps order deterministically.
  async function driveHealth(probes: Array<'ok' | 'fail'>): Promise<void> {
    for (const p of probes) {
      __resetUpstreamProbeCacheOnlyForTests();
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      if (p === 'ok') {
        recordOtpSendSuccess();
      } else {
        recordOtpSendFailure(new Error('timeout'));
      }
      // Sleep 2ms so each record* stamp lands on a distinct ms —
      // OTP-delivery degraded computes by `lastFailureAtMs >
      // lastSuccessAtMs` so identical timestamps create a false
      // healthy reading on the failure side.
      await new Promise((r) => setTimeout(r, 2));
      await app.request('/health');
    }
  }

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

  it('a single failed probe after healthy does not fire the degraded notify', async () => {
    await driveHealth(['ok', 'fail']);
    expect(mockNotifyHealthChange).not.toHaveBeenCalled();
  });

  it('4 of 5 bad probes does NOT trip degraded — threshold is 5-of-window', async () => {
    // Seed healthy, then 4 bad readings. Window = [h,f,f,f,f] —
    // 4 degraded < 5 threshold. The old streak detector would have
    // fired on the 2nd failure in a row; the window tolerates it.
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail']);
    expect(mockNotifyHealthChange).not.toHaveBeenCalled();
  });

  it('5 of 10 bad probes fires degraded exactly once', async () => {
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
    // Window now has 5 degraded — at the threshold.
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1);
    expect(mockNotifyHealthChange).toHaveBeenCalledWith('degraded', expect.any(String));
  });

  it('one transient timeout inside a healthy run is absorbed — no flap to Discord', async () => {
    // Drive a realistic "mostly fine, one blip" pattern. The
    // supermajority stays healthy so nothing fires.
    await driveHealth(['ok', 'ok', 'ok', 'fail', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(mockNotifyHealthChange).not.toHaveBeenCalled();
  });

  it('a partial recovery (4 successes after degraded) is NOT enough to flip back', async () => {
    // Drive into degraded first (6 fails on top of 1 healthy seed).
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1);

    // 4 healthy readings — not enough (threshold is 8 healthy in the
    // 10-wide window).
    await driveHealth(['ok', 'ok', 'ok', 'ok']);
    expect(mockNotifyHealthChange).toHaveBeenCalledTimes(1);
  });

  it('8 of 10 healthy probes after a degraded flip eventually flip back to healthy', async () => {
    // Drive degraded via 5 bad readings on top of 1 seed.
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
    expect(mockNotifyHealthChange).toHaveBeenCalledWith('degraded', expect.any(String));

    // The full-reset below clears the 30-min notify cooldown (this is
    // what stands in the way of the recovery fire in a real process
    // running within the cooldown window; the test fast-forwards it).
    __resetHealthProbeCacheForTests();
    mockNotifyHealthChange.mockReset();

    // Re-seed degraded, then push enough healthy probes to cross
    // the 8-of-10 threshold.
    await driveHealth(['fail', 'fail', 'fail', 'fail', 'fail']); // window = [d,d,d,d,d]
    await driveHealth(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Window now has 8 healthy out of last 10 → flip back.
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

  // A2-1305: end-to-end round-trip for the CTX response request-id
  // echo. Outbound CTX call includes our X-Request-Id; inbound CTX
  // response carries its own X-Request-Id; backend captures it and
  // emits it back to the client as X-Ctx-Request-Id. Pairs with the
  // unit tests in `__tests__/request-context.test.ts` (which lock
  // the AsyncLocalStorage primitive in isolation) — this case
  // exercises the full middleware chain.
  it('A2-1305: echoes the CTX response X-Request-Id back as X-Ctx-Request-Id', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'ok' }), {
        status: 200,
        headers: { 'X-Request-Id': 'ctx-req-abc123' },
      }),
    );

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Ctx-Request-Id')).toBe('ctx-req-abc123');
    // Outbound side of the round-trip (`circuit-breaker.ts` stamping
    // our own X-Request-Id onto the CTX call) is covered by
    // `circuit-breaker.test.ts` directly. The integration mock
    // bypasses wrappedFetch so we can't assert on it here without
    // re-implementing the logic in two places.
  });

  it('A2-1305: omits X-Ctx-Request-Id when no CTX call happened', async () => {
    // /health doesn't fire a CTX fetch (it has its own probe path
    // that we mock separately). Confirm the header is not stamped
    // unconditionally — only when an actual CTX response carries one.
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await app.request('/api/clusters');
    // /api/clusters reads the in-memory merchant store; no outbound
    // fetch fires, so no X-Ctx-Request-Id should be set.
    expect(res.headers.get('X-Ctx-Request-Id')).toBeNull();
  });

  it('A2-1305: falls back to X-Correlation-Id when X-Request-Id is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'ok' }), {
        status: 200,
        headers: { 'X-Correlation-Id': 'ctx-corr-xyz789' },
      }),
    );

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Ctx-Request-Id')).toBe('ctx-corr-xyz789');
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

  it('/openapi.json is private and auth-varying', async () => {
    const res = await app.request('/openapi.json');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Authorization');
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

  it('/metrics exposes runtime health gauges for OTP and workers', async () => {
    recordOtpSendFailure(new Error('provider down'));
    markWorkerStarted('payout_worker', { staleAfterMs: 60_000 });
    markWorkerTickSuccess('payout_worker');

    const res = await app.request('/metrics');
    const body = await res.text();

    expect(body).toContain('# TYPE loop_runtime_surface_degraded gauge');
    expect(body).toContain('loop_runtime_surface_degraded{surface="otp_delivery"} 1');
    expect(body).toContain('# TYPE loop_worker_running gauge');
    expect(body).toContain('loop_worker_running{worker="payout_worker"} 1');
    expect(body).toContain('# TYPE loop_worker_degraded gauge');
    expect(body).toContain('loop_worker_degraded{worker="payout_worker"} 0');
    expect(body).toContain('# TYPE loop_worker_last_success_timestamp_ms gauge');
    expect(body).toMatch(/loop_worker_last_success_timestamp_ms\{worker="payout_worker"\} \d{13}/);
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

describe('bodyLimit middleware (A2-1005)', () => {
  // 1 MB + 1 byte — the smallest overflow the middleware must reject.
  // Send an explicit Content-Length header so hono/bodyLimit's
  // fast-path (which inspects the header) fires; without it the
  // middleware would fall back to streaming the body, and app.request
  // in this harness may hand the body through unparsed.
  it('returns 413 PAYLOAD_TOO_LARGE when body exceeds 1 MB, not 500', async () => {
    const oversized = 'a'.repeat(1024 * 1024 + 1);
    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(oversized.length),
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.message).toMatch(/1 MB/);
  });

  it('passes through normal-sized bodies to the handler', async () => {
    // Use a body small enough to pass the limit but malformed enough
    // for the handler to reject — confirms the bodyLimit middleware
    // isn't over-zealously rejecting legitimate requests.
    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Handler-level 400 for missing email — NOT the middleware's 413.
    expect(res.status).toBe(400);
  });
});
