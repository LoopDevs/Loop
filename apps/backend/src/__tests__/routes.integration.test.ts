import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../config/index.js';

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      ctx: { ...actual.config.ctx, baseUrl: 'http://test-upstream.local' },
      // Audit A-023 / FT-08 — trustProxy enables spoof-proof Fly-Client-IP header reading
      server: { ...actual.config.server, trustProxy: true },
    },
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

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

vi.mock('../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

// A4-034: /health probes store with cheap count; mock shape for happy path
const dbCountMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../db/client.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    db: {
      collection: () => ({ count: dbCountMock }),
    },
  };
});

vi.mock('../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

// CONV-WATCH-02: health-change routed through fleet-wide watchdog_alert_state dedup gate
const applyBinaryWatchdogAlertMock = vi.hoisted(() =>
  vi.fn<
    (args: {
      watchdogName: string;
      shouldBeActive: boolean;
      notifyActive: () => Promise<boolean>;
      notifyRecovered: () => Promise<boolean>;
    }) => Promise<boolean>
  >(async () => true),
);
vi.mock('../discord/watchdog-alert.js', () => ({
  applyBinaryWatchdogAlert: applyBinaryWatchdogAlertMock,
}));

// A2-1305: proxy routes use real upstreamFetch for request-id capture

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
  setOtpDeliveryEnabled,
} from '../runtime-health.js';
import { __resetMetricsForTests, setMoneyIntegrityBreach } from '../metrics.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  applyBinaryWatchdogAlertMock.mockReset().mockResolvedValue(true);
  // Invalidate probe cache and reset hysteresis/cooldown for known state
  __resetHealthProbeCacheForTests();
  __resetRuntimeHealthForTests();
  // A2-1005: reset per-IP counters to prevent state bleed
  __resetRateLimitsForTests();
});

describe('GET /health', () => {
  it('returns 200 with status healthy when upstream is reachable', async () => {
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
    // Keep HTTP 200 to prevent Fly cycling on upstream-only issues
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.upstreamReachable).toBe(false);
    expect(body.softDegraded).toBe(true);
    expect(body.criticalDegraded).toBe(false);
    expect(body.softDegradedReasons).toEqual(expect.arrayContaining(['upstream_unreachable']));
  });

  it('surfaces OTP delivery degradation in /health with HTTP 503', async () => {
    // Arm OTP surface explicitly as recordOtpSendFailure no longer re-arms
    setOtpDeliveryEnabled(true);
    recordOtpSendFailure(new Error('provider down'));
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await app.request('/health');
    // A4-035 / A4-073: degraded OTP counts as degraded backend
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

    await app.request('/health');
    await app.request('/health');
    await app.request('/health');
    await app.request('/health');
    await app.request('/health');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Flap damping: rolling-window detector (5-of-10 degraded trips, 8-of-10 healthy recovers)
  // Keys on criticalDegraded only; upstream blips do not rotate window.
  async function driveHealth(probes: Array<'ok' | 'fail'>): Promise<void> {
    setOtpDeliveryEnabled(true);
    for (const p of probes) {
      __resetUpstreamProbeCacheOnlyForTests();
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      if (p === 'ok') {
        recordOtpSendSuccess();
      } else {
        recordOtpSendFailure(new Error('timeout'));
      }
      // Distinct ms timestamps prevent false healthy reading on failure side
      await new Promise((r) => setTimeout(r, 2));
      await app.request('/health');
    }
  }

  it('body always reflects raw reading — Fly liveness must not be debounced', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    const res = await app.request('/health');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded');
    expect(applyBinaryWatchdogAlertMock).not.toHaveBeenCalled();
  });

  it('a single failed probe after healthy does not fire the degraded notify', async () => {
    await driveHealth(['ok', 'fail']);
    expect(applyBinaryWatchdogAlertMock).not.toHaveBeenCalled();
  });

  it('4 of 5 bad probes does NOT trip degraded — threshold is 5-of-window', async () => {
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail']);
    expect(applyBinaryWatchdogAlertMock).not.toHaveBeenCalled();
  });

  it('5 of 10 bad probes fires degraded exactly once', async () => {
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
    expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledTimes(1);
    expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ watchdogName: 'health-change', shouldBeActive: true }),
    );
  });

  it('one transient timeout inside a healthy run is absorbed — no flap to Discord', async () => {
    await driveHealth(['ok', 'ok', 'ok', 'fail', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(applyBinaryWatchdogAlertMock).not.toHaveBeenCalled();
  });

  it('a partial recovery (4 successes after degraded) is NOT enough to flip back', async () => {
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
    expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledTimes(1);

    await driveHealth(['ok', 'ok', 'ok', 'ok']);
    expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledTimes(1);
  });

  it('8 of 10 healthy probes after a degraded flip eventually flip back to healthy', async () => {
    await driveHealth(['ok', 'fail', 'fail', 'fail', 'fail', 'fail']);
    expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ watchdogName: 'health-change', shouldBeActive: true }),
    );

    __resetHealthProbeCacheForTests();
    applyBinaryWatchdogAlertMock.mockReset().mockResolvedValue(true);

    await driveHealth(['fail', 'fail', 'fail', 'fail', 'fail']);
    await driveHealth(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(applyBinaryWatchdogAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ watchdogName: 'health-change', shouldBeActive: false }),
    );
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
        headers: { 'Content-Type': 'application/json', 'fly-client-ip': ip },
        body: JSON.stringify({ email: 'u@example.com' }),
      });

    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    for (let i = 0; i < 5; i++) await doReq();

    const limited = await doReq();
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
  });

  it('sets X-Request-Id header on every response', async () => {
    const res = await app.request('/health');
    const id = res.headers.get('X-Request-Id');
    expect(id).not.toBeNull();
    expect(id!.length).toBeGreaterThan(0);
  });

  // A2-1305: end-to-end round-trip for CTX response request-id echo
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

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const outbound = new Headers(init.headers);
    expect(outbound.get('X-Request-Id')).toBeTruthy();
  });

  it('A2-1305: omits X-Ctx-Request-Id when no CTX call happened', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await app.request('/api/clusters');
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
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('/metrics labels unmatched routes as NOT_FOUND (audit A-022)', async () => {
    await app.request('/fuzz-path-1');
    await app.request('/fuzz-path-2');
    await app.request('/fuzz-path-3?q=abc');
    await app.request('/api/totally-made-up-endpoint');

    const res = await app.request('/metrics');
    const body = await res.text();

    for (const path of [
      '/fuzz-path-1',
      '/fuzz-path-2',
      '/fuzz-path-3',
      '/api/totally-made-up-endpoint',
    ]) {
      expect(body).not.toContain(`route="${path}"`);
    }
    expect(body).toMatch(
      /loop_requests_total\{method="GET",route="NOT_FOUND",status="404"\} [1-9]/,
    );
  });

  it('/metrics exposes Prometheus-format counters', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await app.request('/health');

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('# TYPE loop_rate_limit_hits_total counter');
    expect(body).toContain('# TYPE loop_requests_total counter');
    expect(body).toMatch(/loop_requests_total\{method="GET",route="\/health",status="200"\}/);
  });

  it('/metrics exposes runtime health gauges for OTP and workers', async () => {
    setOtpDeliveryEnabled(true);
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
    // B-5: wedged-fleet lead-tick signal (S4-8)
    expect(body).toContain('# TYPE loop_worker_last_lead_tick_timestamp_ms gauge');
    expect(body).toMatch(
      /loop_worker_last_lead_tick_timestamp_ms\{worker="payout_worker"\} \d{13}/,
    );
    expect(body).toContain('# TYPE loop_worker_stale gauge');
    expect(body).toContain('loop_worker_stale{worker="payout_worker"} 0');
  });

  it('/metrics exposes catalog freshness gauges (B-5, docs/slo.md §Freshness)', async () => {
    const res = await app.request('/metrics');
    const body = await res.text();

    expect(body).toContain('# TYPE loop_catalog_loaded_timestamp_ms gauge');
    expect(body).toMatch(/loop_catalog_loaded_timestamp_ms\{catalog="merchants"\} \d{13}/);
    expect(body).toMatch(/loop_catalog_loaded_timestamp_ms\{catalog="locations"\} \d{13}/);
    expect(body).toContain('# TYPE loop_catalog_stale gauge');
    expect(body).toContain('loop_catalog_stale{catalog="merchants"} 0');
    expect(body).toContain('loop_catalog_stale{catalog="locations"} 0');
  });

  it('/metrics exposes geo-db and rate-limit-fleet gauges (B-5)', async () => {
    const res = await app.request('/metrics');
    const body = await res.text();

    expect(body).toContain('# TYPE loop_geo_db_stale gauge');
    expect(body).toContain('loop_geo_db_stale 0');
    expect(body).not.toContain('loop_geo_db_build_age_days');

    expect(body).toContain('# TYPE loop_rate_limit_fleet_estimate gauge');
    expect(body).toMatch(/loop_rate_limit_fleet_estimate \d+/);
    expect(body).toContain('# TYPE loop_rate_limit_fleet_estimate_source gauge');
    expect(body).toContain('loop_rate_limit_fleet_estimate_source 0');
  });

  it('/metrics exposes money-integrity breach gauges independent of Discord (FT-07/NS-02)', async () => {
    __resetMetricsForTests();
    setMoneyIntegrityBreach('ledger_invariant', true);
    setMoneyIntegrityBreach('vault_solvency', true);
    setMoneyIntegrityBreach('asset_drift', false);

    const res = await app.request('/metrics');
    const body = await res.text();

    expect(body).toContain('# TYPE loop_money_integrity_breach_active gauge');
    expect(body).toContain('loop_money_integrity_breach_active{signal="ledger_invariant"} 1');
    expect(body).toContain('loop_money_integrity_breach_active{signal="vault_solvency"} 1');
    expect(body).toContain('loop_money_integrity_breach_active{signal="asset_drift"} 0');
    expect(body).not.toContain('loop_money_integrity_breach_active{signal="operator_float"}');
    expect(body).toContain('# TYPE loop_money_integrity_last_evaluated_timestamp_ms gauge');
    expect(body).toMatch(
      /loop_money_integrity_last_evaluated_timestamp_ms\{signal="ledger_invariant"\} \d{13}/,
    );

    __resetMetricsForTests();
  });

  it('/metrics emits exactly one HELP line per metric (audit A-016)', async () => {
    const res = await app.request('/metrics');
    const body = await res.text();
    for (const metric of [
      'loop_rate_limit_hits_total',
      'loop_requests_total',
      'loop_worker_last_lead_tick_timestamp_ms',
      'loop_worker_stale',
      'loop_catalog_loaded_timestamp_ms',
      'loop_catalog_stale',
      'loop_geo_db_stale',
      'loop_rate_limit_fleet_estimate',
      'loop_rate_limit_fleet_estimate_source',
      'loop_money_integrity_breach_active',
      'loop_money_integrity_last_evaluated_timestamp_ms',
    ]) {
      const helpLines = body.split('\n').filter((l) => l.startsWith(`# HELP ${metric} `));
      expect(helpLines, `expected exactly one HELP line for ${metric}`).toHaveLength(1);
    }
  });
});

describe('bodyLimit middleware (A2-1005)', () => {
  // 1 MB + 1 byte overflow; explicit Content-Length triggers fast-path
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
    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // BK-bodylimit: globalRateLimit must sit ahead of bodyLimit to count oversized floods
  it('BK-bodylimit: oversized-body requests hit the global rate limit (429), not the size check (413), once the per-IP budget is spent', async () => {
    const ip = '198.51.100.200';
    const GLOBAL_BUDGET = 600;
    for (let i = 0; i < GLOBAL_BUDGET; i++) {
      const primer = await app.request('/api/bk-bodylimit-prime', {
        method: 'GET',
        headers: { 'fly-client-ip': ip },
      });
      expect(primer.status).toBe(404);
    }

    const oversized = 'a'.repeat(1024 * 1024 + 1);
    const res = await app.request('/api/bk-bodylimit-prime', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(oversized.length),
        'fly-client-ip': ip,
      },
      body: oversized,
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('RATE_LIMITED');
  });
});
