import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { getConnInfo } from '@hono/node-server/conninfo';
import { sentry, captureException } from '@sentry/hono/node';
import { env } from './env.js';
import { logger } from './logger.js';
import { getLocations, isLocationLoading } from './clustering/data-store.js';
import { getMerchants } from './merchants/sync.js';
import { clustersHandler } from './clustering/handler.js';
import { imageProxyHandler, evictExpiredImageCache } from './images/proxy.js';
import { upstreamUrl } from './upstream.js';
import { getAllCircuitStates } from './circuit-breaker.js';
import { generateOpenApiSpec } from './openapi.js';
import {
  merchantListHandler,
  merchantAllHandler,
  merchantBySlugHandler,
  merchantCashbackRateHandler,
  merchantDetailHandler,
  merchantsCashbackRatesHandler,
} from './merchants/handler.js';
import {
  requestOtpHandler,
  verifyOtpHandler,
  refreshHandler,
  logoutHandler,
  requireAuth,
} from './auth/handler.js';
import { createOrderHandler, listOrdersHandler, getOrderHandler } from './orders/handler.js';
import {
  loopCreateOrderHandler,
  loopGetOrderHandler,
  loopListOrdersHandler,
} from './orders/loop-handler.js';
import { configHandler } from './config/handler.js';
import { googleSocialLoginHandler, appleSocialLoginHandler } from './auth/social.js';
import { notifyHealthChange } from './discord.js';
import { requireAdmin } from './auth/require-admin.js';
import { listConfigsHandler, upsertConfigHandler, configHistoryHandler } from './admin/handler.js';
import { treasuryHandler } from './admin/treasury.js';
import { adminListPayoutsHandler, adminRetryPayoutHandler } from './admin/payouts.js';
import { adminPayoutsCsvHandler } from './admin/payouts-csv.js';
import { adminListOrdersHandler } from './admin/orders.js';
import {
  getCashbackHistoryHandler,
  getMeHandler,
  getUserPendingPayoutsHandler,
  setHomeCurrencyHandler,
  setStellarAddressHandler,
} from './users/handler.js';

export const app = new Hono();

// Sentry middleware — captures request context, performance, and errors
if (env.SENTRY_DSN) {
  app.use(
    sentry(app, {
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
    }),
  );
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/**
 * Resolves the client IP the rate limiter should key on. Audit A-023:
 * previously `c.req.header('x-forwarded-for')?.split(',')[0]` was used
 * unconditionally, meaning any client could send an `X-Forwarded-For`
 * header with an arbitrary value and bypass per-IP limits by rotating
 * that value.
 *
 * Policy:
 *   - `env.TRUST_PROXY === true`: we're behind a trusted edge proxy
 *     (Fly.io, nginx, Cloud Run, etc.) that writes X-Forwarded-For. Use
 *     the leftmost value — that's the original client the edge saw.
 *   - `env.TRUST_PROXY === false`: no trusted proxy in front of us. Use
 *     the TCP socket's remote address. Ignores X-Forwarded-For entirely.
 *
 * Returns the string `'unknown'` only if both sources fail — rate limits
 * still apply but everyone lands in the same bucket, which is
 * conservative.
 */
function clientIpFor(c: Context): string {
  if (env.TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff !== undefined && xff.length > 0) {
      const first = xff.split(',')[0]?.trim();
      if (first !== undefined && first.length > 0) return first;
    }
  }
  try {
    const info = getConnInfo(c);
    const address = info.remote.address;
    if (address !== undefined && address.length > 0) return address;
  } catch {
    /* conninfo unavailable — dev server/test harness */
  }
  return 'unknown';
}

/**
 * Test helper: wipe the rate-limit map between cases. Module state
 * persists across `app.request(...)` calls, so a test that exercises
 * the same route many times in a loop will start receiving 429 as soon
 * as it passes the route's per-minute budget. Tests that hit the budget
 * intentionally (the order-validation suite fires dozens of rejections
 * back-to-back) call this from `beforeEach` to reset.
 */
export function __resetRateLimitsForTests(): void {
  rateLimitMap.clear();
}

/**
 * Test helper: clear the /health upstream-probe cache. The `/health`
 * handler caches the upstream fetch result for 10s so that external
 * spammers don't generate outbound traffic proportional to inbound.
 * Tests that simulate upstream reachability changes need to invalidate
 * the cache between cases to observe the transition.
 */
export function __resetHealthProbeCacheForTests(): void {
  upstreamProbeCache = null;
  upstreamProbeInFlight = null;
}

// Cap on the rate-limit map. Without this, an attacker spraying requests
// from fresh IPs faster than the hourly cleanup runs could grow the map
// until the process OOMs. With the cap, once we hit it we evict the
// oldest entry before inserting — the attacker loses memory of their own
// earlier hits but we stay stable.
const RATE_LIMIT_MAP_MAX = 10_000;

/** Simple per-IP rate limiter. Returns 429 if limit exceeded within the window. */
function rateLimit(
  maxRequests: number,
  windowMs: number,
): (c: Context, next: () => Promise<void>) => Promise<void | Response> {
  return async (c, next): Promise<void | Response> => {
    const ip = clientIpFor(c);
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (entry === undefined || now > entry.resetAt) {
      // Evict the oldest entry if we're at capacity. Map iteration order is
      // insertion order, so keys().next().value is the oldest.
      if (rateLimitMap.size >= RATE_LIMIT_MAP_MAX && entry === undefined) {
        const oldest = rateLimitMap.keys().next().value;
        if (oldest !== undefined) rateLimitMap.delete(oldest);
      }
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > maxRequests) {
        // Tell the client when the window resets so clients can back off
        // instead of hot-looping retries.
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        c.header('Retry-After', String(retryAfterSec));
        metrics.rateLimitHitsTotal++;
        return c.json({ code: 'RATE_LIMITED', message: 'Too many requests' }, 429);
      }
    }

    await next();
  };
}

// ─── Global middleware ────────────────────────────────────────────────────────

// Production CORS allowlist. The three non-web origins below are the local
// schemes Capacitor WebViews use on iOS (default `capacitor://localhost`)
// and Android (`https://localhost` since Capacitor 3; `http://localhost`
// kept as well for older debug builds). Without them, every fetch from the
// native app to the production API would fail preflight — a "works in dev,
// CORS errors in production" regression on mobile release that would be
// easy to catch late.
const PRODUCTION_ORIGINS = [
  'https://loopfinance.io',
  'https://www.loopfinance.io',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
];

app.use(
  '*',
  cors({
    origin: env.NODE_ENV === 'production' ? PRODUCTION_ORIGINS : '*',
  }),
);
app.use(
  '*',
  secureHeaders({
    crossOriginResourcePolicy: env.NODE_ENV === 'production' ? 'same-origin' : 'cross-origin',
    // API-appropriate CSP: this host only ever serves JSON/binary data
    // (no HTML), so any browser that receives an injected response should
    // refuse to execute scripts or load sub-resources from it. default-src
    // 'none' is the strictest possible base; frame-ancestors 'none'
    // prevents clickjacking embeds even on error pages. A second line of
    // defense against any future XSS class of bug (like the ClusterMap
    // innerHTML one caught in the hardening sweep).
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  }),
);
app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
app.use('*', requestId());

// Audit A-021: replace the default `hono/logger` with a Pino-backed
// access logger so request logs share the same structure, redaction
// list, and transport as the rest of the backend. Correlates with the
// handler-side logs via the `requestId` context variable that Hono's
// `requestId()` middleware (`app.use('*', requestId())` above) sets —
// that middleware writes the id to the response header and the context
// var but does NOT mutate the incoming request's headers, so reading
// `c.req.header('X-Request-Id')` would be undefined for every client
// that didn't already send one (almost all of them).
const accessLog = logger.child({ component: 'access' });
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  accessLog.info(
    {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: ms,
      requestId: c.get('requestId') ?? c.req.header('X-Request-Id'),
    },
    `${c.req.method} ${c.req.path} ${status} ${ms}ms`,
  );
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface Metrics {
  rateLimitHitsTotal: number;
  requestsTotal: Map<string, number>;
}
const metrics: Metrics = {
  rateLimitHitsTotal: 0,
  requestsTotal: new Map(),
};

// Request counter middleware. Runs after all other middleware + the handler
// so it observes the final status. Keys are `METHOD:ROUTE:STATUS` with the
// route being the matched pattern (not the URL) to keep cardinality bounded.
//
// Audit A-022: unmatched paths had no routePath, so the fallback emitted
// the raw URL as the label. A fuzz scan (or an ordinary crawler) could
// then spray `/api/foo`, `/api/bar`, `/xyz-…` and each would create a
// fresh metric key, ballooning the Prometheus series cardinality until
// the map (and the scraper) struggled. Collapse every unmatched route
// to the single constant label `NOT_FOUND` so cardinality stays O(number
// of declared routes).
app.use('*', async (c, next) => {
  await next();
  // Skip the metrics endpoint itself so we don't count our own scraper.
  if (c.req.path === '/metrics') return;
  // Hono sets routePath to the matched middleware pattern when no route
  // handler matches (for us, that's the wildcard catch-all '/*' or '*').
  // Treat both as NOT_FOUND — everything else is a real registered route.
  const raw = c.req.routePath;
  const route = raw === undefined || raw === '/*' || raw === '*' ? 'NOT_FOUND' : raw;
  const key = `${c.req.method}:${route}:${c.res.status}`;
  metrics.requestsTotal.set(key, (metrics.requestsTotal.get(key) ?? 0) + 1);
});

app.get('/metrics', (c) => {
  const lines: string[] = [];

  lines.push('# HELP loop_rate_limit_hits_total Total 429 responses issued.');
  lines.push('# TYPE loop_rate_limit_hits_total counter');
  lines.push(`loop_rate_limit_hits_total ${metrics.rateLimitHitsTotal}`);
  lines.push('');

  lines.push('# HELP loop_requests_total Total HTTP requests by method/route/status.');
  lines.push('# TYPE loop_requests_total counter');
  for (const [key, count] of metrics.requestsTotal) {
    const [method, route, status] = key.split(':');
    const labels = `method="${method}",route="${route}",status="${status}"`;
    lines.push(`loop_requests_total{${labels}} ${count}`);
  }
  lines.push('');

  // Prometheus exposition format allows exactly one HELP line per metric.
  // We used to emit two (one for the description, one for the state-value
  // mapping) which some scrapers/parsers rejected outright. Merge into one
  // and move the mapping into separate comment lines so the information
  // is still visible but not mistaken for metadata.
  lines.push(
    '# HELP loop_circuit_state Circuit breaker state per upstream endpoint (0=closed, 1=half_open, 2=open).',
  );
  lines.push('# TYPE loop_circuit_state gauge');
  for (const [key, state] of Object.entries(getAllCircuitStates())) {
    const val = state === 'closed' ? 0 : state === 'half_open' ? 1 : 2;
    lines.push(`loop_circuit_state{endpoint="${key}"} ${val}`);
  }

  return c.text(lines.join('\n') + '\n', 200, {
    'Content-Type': 'text/plain; version=0.0.4',
    // /metrics reports live counters + gauges. A CDN in front caching
    // this would report stale numbers to the scraper; no-store makes
    // that impossible without requiring specific scraper config.
    'Cache-Control': 'no-store',
  });
});

// ─── OpenAPI spec ─────────────────────────────────────────────────────────────

// Generate once at module load. The spec is a pure function of the zod
// registrations in openapi.ts — it does not depend on runtime state — so
// serializing on every request would just burn CPU.
const openApiSpec = generateOpenApiSpec();
app.get('/openapi.json', (c) =>
  c.json(openApiSpec, 200, { 'Cache-Control': 'public, max-age=3600' }),
);

// ─── Test-only reset endpoint ─────────────────────────────────────────────────
//
// Mocked e2e tests run against this process as a long-lived server (each
// test spawns a fresh browser context but hits the same backend). Per-IP
// rate-limit state accumulates across tests — a single IP exercising
// `/api/auth/request-otp` across multiple tests + Playwright retries will
// blow through the 5/min budget and start seeing 429, which manifests as
// a disabled Continue button that never re-enables (the UI sees it as a
// network error and leaves auth-loading stuck in its cleanup path).
//
// Expose a reset hook for the mocked suite's `beforeEach` to call. Gated
// on `NODE_ENV=test` so production can't be nudged into dropping the
// limiter. The unit-test rate-limit coverage (see
// `routes.integration.test.ts`) imports `__resetRateLimitsForTests`
// directly and isn't affected by this endpoint.
if (env.NODE_ENV === 'test') {
  // Deliberately outside the `/api` namespace so it doesn't appear in
  // the OpenAPI spec and the lint-docs "route must be in architecture.md"
  // check leaves it alone.
  app.post('/__test__/reset', (c) => {
    rateLimitMap.clear();
    upstreamProbeCache = null;
    upstreamProbeInFlight = null;
    return c.json({ message: 'reset' });
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────

let lastHealthStatus: 'healthy' | 'degraded' | null = null;

// Cache the upstream reachability probe: `/health` is unauthenticated and
// unrate-limited (Fly.io probes it every 15s, k8s-ish liveness patterns also
// do the same). Without a cache every external call — including from an
// attacker spamming the endpoint — triggers a fresh outbound fetch to CTX,
// which both generates upstream load we don't want to be responsible for
// and burns our local socket budget. 10s is shorter than the Fly probe
// interval so the cached value is always the one from the last probe.
const UPSTREAM_PROBE_TTL_MS = 10_000;
let upstreamProbeCache: { reachable: boolean; at: number } | null = null;
let upstreamProbeInFlight: Promise<boolean> | null = null;

async function probeUpstream(): Promise<boolean> {
  const now = Date.now();
  if (upstreamProbeCache !== null && now - upstreamProbeCache.at < UPSTREAM_PROBE_TTL_MS) {
    return upstreamProbeCache.reachable;
  }
  // Coalesce concurrent probes — a burst of /health requests that arrive
  // within the TTL window should share one outbound fetch, not each fire
  // their own.
  if (upstreamProbeInFlight !== null) return upstreamProbeInFlight;

  upstreamProbeInFlight = (async () => {
    let reachable = true;
    try {
      // Deliberately bare `fetch`, NOT `getUpstreamCircuit('status').fetch`.
      // /health needs to detect upstream *recovery*; if we routed through
      // a circuit breaker that was open (because a different endpoint just
      // failed, for example), the probe would short-circuit to
      // CircuitOpenError and /health would keep reporting `degraded` long
      // after upstream came back. See `docs/architecture.md §Circuit
      // breaker` — this is the one documented exception to the AGENTS.md
      // "never bare fetch" rule for upstream calls.
      const res = await fetch(upstreamUrl('/status'), { signal: AbortSignal.timeout(3000) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    upstreamProbeCache = { reachable, at: Date.now() };
    upstreamProbeInFlight = null;
    return reachable;
  })();
  return upstreamProbeInFlight;
}

app.get('/health', async (c) => {
  const { locations, loadedAt: locLoadedAt } = getLocations();
  const { merchants, loadedAt: merLoadedAt } = getMerchants();

  // Check staleness — data older than 2x the refresh interval is stale
  const now = Date.now();
  const merchantStaleMs = env.REFRESH_INTERVAL_HOURS * 2 * 60 * 60 * 1000;
  const locationStaleMs = env.LOCATION_REFRESH_INTERVAL_HOURS * 2 * 60 * 60 * 1000;
  const merchantsStale = now - merLoadedAt > merchantStaleMs;
  const locationsStale = now - locLoadedAt > locationStaleMs;

  const upstreamReachable = await probeUpstream();

  const degraded = merchantsStale || locationsStale || !upstreamReachable;

  const currentStatus = degraded ? 'degraded' : 'healthy';
  if (lastHealthStatus !== null && lastHealthStatus !== currentStatus) {
    const details = degraded
      ? `Merchants stale: ${merchantsStale}, Locations stale: ${locationsStale}, Upstream: ${upstreamReachable ? 'up' : 'DOWN'}`
      : 'All systems operational';
    notifyHealthChange(currentStatus, details);
  }
  lastHealthStatus = currentStatus;

  // /health reports live service state (merchant/location staleness,
  // upstream reachability). A CDN in front caching this would serve
  // "healthy" for the cache TTL after upstream went down — masking
  // outages from external probes. `no-store` is the safe default
  // even though Fly's own probe path doesn't cache.
  c.header('Cache-Control', 'no-store');
  return c.json({
    status: degraded ? 'degraded' : 'healthy',
    locationCount: locations.length,
    locationsLoading: isLocationLoading(),
    merchantCount: merchants.length,
    merchantsLoadedAt: new Date(merLoadedAt).toISOString(),
    locationsLoadedAt: new Date(locLoadedAt).toISOString(),
    merchantsStale,
    locationsStale,
    upstreamReachable,
  });
});

// ─── Map clustering ───────────────────────────────────────────────────────────

// 60 requests per IP per minute. Each cluster request iterates every cached
// location and computes centroids; real clients are debounced at 300ms in
// ClusterMap so 60/min leaves them plenty of headroom while stopping a bot
// from spamming varied bounds/zoom to pressure the backend.
app.get('/api/clusters', rateLimit(60, 60_000), clustersHandler);

// ─── Public client config ────────────────────────────────────────────────────

// ADR 010 / ADR 013. Small object of feature flags the web client
// needs to decide which code paths to take. Unauthenticated — the
// client needs this before login. Rate-limited generously; the
// response is Cache-Control: max-age=600 so a healthy client hits
// it rarely.
app.get('/api/config', rateLimit(120, 60_000), configHandler);

// ─── Image proxy ──────────────────────────────────────────────────────────────

// 300 requests per IP per minute — images load progressively (lazy + cached), not all at once
app.get('/api/image', rateLimit(300, 60_000), imageProxyHandler);

// ─── Merchants ────────────────────────────────────────────────────────────────

app.get('/api/merchants', merchantListHandler);
// /all must come before /:id so that 'all' is not interpreted as an id.
app.get('/api/merchants/all', merchantAllHandler);
app.get('/api/merchants/by-slug/:slug', merchantBySlugHandler); // must be before /:id
// GET /api/merchants/cashback-rates — bulk map of active cashback
// pcts across every merchant (ADR 011 / 015). Lets catalog / list /
// map views render "X% cashback" badges without N+1-ing the
// per-merchant endpoint. Static literal path — must come BEFORE the
// `/:merchantId/cashback-rate` route so Hono's router matches the
// literal instead of treating "cashback-rates" as a path param.
app.get('/api/merchants/cashback-rates', rateLimit(120, 60_000), merchantsCashbackRatesHandler);
// GET /api/merchants/:merchantId/cashback-rate — public cashback-rate
// preview for rendering "Earn X% cashback" on the gift-card detail page
// (ADR 011 / 015). Registered BEFORE the requireAuth gate on /:id so
// the checkout page can query it without a bearer. Own rate limit
// since the gift-card detail page fires it alongside the merchant
// detail fetch; 120/min per IP matches the other merchant reads.
app.get(
  '/api/merchants/:merchantId/cashback-rate',
  rateLimit(120, 60_000),
  merchantCashbackRateHandler,
);
// Authenticated — the handler calls CTX /merchants/:id with the user's
// bearer + X-Client-Id to enrich the cached merchant with long-form
// content (description / longDescription / terms / instructions).
// Unauthed callers still see the basic cached merchant via by-slug.
app.use('/api/merchants/:id', requireAuth);
app.get('/api/merchants/:id', merchantDetailHandler);

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Auth responses carry access + refresh tokens. POST/DELETE aren't cached
// by standards-compliant caches, but a misconfigured intermediate proxy
// that treats any HTTP response as cacheable would otherwise hand one
// user's freshly-minted tokens to the next caller of the same URL. Same
// defense-in-depth pattern used for /api/orders.
app.use('/api/auth/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

app.post('/api/auth/request-otp', rateLimit(5, 60_000), requestOtpHandler);
// OTP brute-force defense: 10 attempts per minute per IP. With a 6-digit code
// that caps guesses at ~14,400/day — upstream lockout/expiry happens first.
app.post('/api/auth/verify-otp', rateLimit(10, 60_000), verifyOtpHandler);
// Refresh abuse defense: legit clients refresh once per access-token lifetime,
// so 30/min per IP leaves plenty of headroom without enabling spray attacks.
app.post('/api/auth/refresh', rateLimit(30, 60_000), refreshHandler);
// Social login (ADR 014). Same 10/min cap as verify-otp — both
// are unauthenticated entry points and both resolve to a minted
// Loop JWT pair on success.
app.post('/api/auth/social/google', rateLimit(10, 60_000), googleSocialLoginHandler);
app.post('/api/auth/social/apple', rateLimit(10, 60_000), appleSocialLoginHandler);
// Logout: 20/min per IP. The handler fans out to an upstream revoke, so
// without a limit an attacker could cheaply spam arbitrary refresh tokens
// at CTX through us.
app.delete('/api/auth/session', rateLimit(20, 60_000), logoutHandler);

// ─── Orders (authenticated) ───────────────────────────────────────────────────
//
// Per-IP rate limits here are defense in depth beyond requireAuth: a
// compromised or leaked bearer token would otherwise let the attacker
// hammer us — creating billable orders upstream (POST), or spamming
// CTX with list/read traffic (GET). Budgets are tuned against legit
// usage:
//   - POST: a user rarely creates more than one order per minute;
//     10/min leaves room for retry-after-error without enabling abuse.
//   - GET /api/orders: the Orders page navigates; 60/min is generous.
//   - GET /api/orders/:id: PaymentStep polls every 3s (~20/min);
//     120/min accommodates multiple pending orders and a retry burst.

// Force Cache-Control: private, no-store on every response under
// /api/orders — these contain a specific user's purchase history and
// gift-card redemption payloads. Without this, a CDN or intermediate
// proxy keyed on URL alone (not Authorization) could cache one user's
// `GET /api/orders` response and serve it to another user's next
// request. Fly.io itself doesn't proxy-cache, but this removes the
// footgun before any future edge caching is introduced.
//
// Registered BEFORE requireAuth so the header still applies on the
// 401 response requireAuth emits when no Bearer is present — a
// misbehaving CDN that caches 401s wouldn't then leak the "this URL
// needs auth" shape across requests.
app.use('/api/orders', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.use('/api/orders/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

app.use('/api/orders', requireAuth);
app.use('/api/orders/*', requireAuth);

app.post('/api/orders', rateLimit(10, 60_000), createOrderHandler);
app.get('/api/orders', rateLimit(60, 60_000), listOrdersHandler);
app.get('/api/orders/:id', rateLimit(120, 60_000), getOrderHandler);
// Loop-native order creation (ADR 010). Lives at a distinct path so
// the legacy CTX-proxy flow at POST /api/orders stays live during
// the migration window. Gated inside the handler on
// LOOP_AUTH_NATIVE_ENABLED — off → 404.
app.post('/api/orders/loop', rateLimit(10, 60_000), loopCreateOrderHandler);
// Loop-native orders list (ADR 010). Listed before :id so the path
// param doesn't capture 'list' or similar; rate 60/min matches the
// legacy /api/orders GET.
app.get('/api/orders/loop', rateLimit(60, 60_000), loopListOrdersHandler);
// Loop-native order GET. The UI polls this while an order is
// pending_payment → paid → procuring → fulfilled, so the rate is
// generous. Owner-scoped: the handler 404s on a non-owner read so
// existence isn't leaked.
app.get('/api/orders/loop/:id', rateLimit(120, 60_000), loopGetOrderHandler);

// ─── User profile ───────────────────────────────────────────────────────────
//
// `GET /api/users/me` returns the caller's profile: id, email, admin
// flag, and home_currency (ADR 015). Works against both Loop-native
// and legacy CTX bearers — CTX bearers upsert the Loop user row on
// first touch, Loop bearers resolve by userId.
app.use('/api/users/me', requireAuth);
app.use('/api/users/me/*', requireAuth);
app.use('/api/users/me', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.use('/api/users/me/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.get('/api/users/me', rateLimit(60, 60_000), getMeHandler);
// POST /api/users/me/home-currency — onboarding-time picker (ADR 015).
// Rate limit lower than GET: users only hit this during signup, so 10/min
// is plenty of headroom for a double-tap retry without enabling enumeration.
app.post('/api/users/me/home-currency', rateLimit(10, 60_000), setHomeCurrencyHandler);
// PUT /api/users/me/stellar-address — opt in / out of on-chain cashback
// payouts by linking a Stellar address (ADR 015). Null body unlinks.
// Rate-limited same cadence as other profile writes — a user changing
// wallets is a low-volume action, 10/min is plenty without enabling
// enumeration.
app.put('/api/users/me/stellar-address', rateLimit(10, 60_000), setStellarAddressHandler);
// GET /api/users/me/cashback-history — paginated credit-ledger events for
// the caller (ADR 009 / 015). 60/min matches the profile GET cadence; the
// Account page loads it alongside /me on mount, and TanStack Query invalidates
// it after any ledger-touching admin action (support edits, payouts).
app.get('/api/users/me/cashback-history', rateLimit(60, 60_000), getCashbackHistoryHandler);
// GET /api/users/me/pending-payouts — caller-scoped on-chain payout
// rows (ADR 015 / 016). 60/min matches the history endpoint; clients
// typically poll this from /settings/cashback while a payout is in
// flight. State + before + limit query shape mirrors the admin endpoint.
app.get('/api/users/me/pending-payouts', rateLimit(60, 60_000), getUserPendingPayoutsHandler);

// ─── Admin (authenticated + admin-flagged) ──────────────────────────────────
//
// Cashback config CRUD (ADR 011). Layered middleware: requireAuth to
// attach the bearer, then requireAdmin to upsert the Loop user row,
// gate on is_admin, and set c.get('user'). Rate-limited same as the
// other authenticated surfaces — an admin still hits the limiter,
// but the limits are generous since it's a low-volume UI.
app.use('/api/admin/*', requireAuth);
app.use('/api/admin/*', requireAdmin);

app.get('/api/admin/merchant-cashback-configs', rateLimit(120, 60_000), listConfigsHandler);
app.put(
  '/api/admin/merchant-cashback-configs/:merchantId',
  rateLimit(60, 60_000),
  upsertConfigHandler,
);
app.get(
  '/api/admin/merchant-cashback-configs/:merchantId/history',
  rateLimit(120, 60_000),
  configHistoryHandler,
);
app.get('/api/admin/treasury', rateLimit(60, 60_000), treasuryHandler);
// Pending-payouts backlog list (ADR 015). Admin UI's "payouts" page
// drills into pending/submitted/confirmed/failed rows; counts for the
// at-a-glance card come from the treasury snapshot above.
app.get('/api/admin/payouts', rateLimit(60, 60_000), adminListPayoutsHandler);
// Finance-ready CSV export of pending_payouts rows. Lower rate
// limit than the JSON list because exports scan rows 500× the
// size of a pagination fetch.
app.get('/api/admin/payouts.csv', rateLimit(10, 60_000), adminPayoutsCsvHandler);
// POST /api/admin/payouts/:id/retry — flip a failed row back to pending.
// Lower rate limit: retries should be rare, one-at-a-time ops actions.
app.post('/api/admin/payouts/:id/retry', rateLimit(20, 60_000), adminRetryPayoutHandler);
// Loop-native orders drill-down (ADR 011 / 015). Paginated, filterable
// by state and userId. Ops uses this to triage stuck orders + audit
// the cashback split + correlate with operator-pool health.
app.get('/api/admin/orders', rateLimit(60, 60_000), adminListOrdersHandler);

// ─── 404 fallback ────────────────────────────────────────────────────────────

// Return our consistent JSON error shape for unmatched routes instead of
// Hono's default text 404 so clients can parse errors uniformly.
app.notFound((c) => {
  return c.json({ code: 'NOT_FOUND', message: 'Route not found' }, 404);
});

// ─── Error handler ───────────────────────────────────────────────────────────

// Catch-all error handler — explicitly capture to Sentry + return clean JSON.
// Includes the request ID so clients can report specific failures without us
// having to cross-reference Sentry timestamps.
app.onError((err, c) => {
  captureException(err);
  const requestId = c.get('requestId') ?? c.req.header('X-Request-Id');
  return c.json(
    { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    500,
  );
});

// ─── Periodic cleanup ────────────────────────────────────────────────────────

function runCleanup(): void {
  evictExpiredImageCache();
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}

// Start the cleanup interval unless we are in the test runner — tests import
// app.ts repeatedly and a leaked interval keeps vitest alive and can trigger
// timer-leak warnings in suites that use vi.useFakeTimers().
let cleanupInterval: NodeJS.Timeout | null = null;
if (env.NODE_ENV !== 'test') {
  cleanupInterval = setInterval(runCleanup, 60 * 60 * 1000);
}

/** Stops the periodic cleanup interval. Intended for graceful shutdown. */
export function stopCleanupInterval(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
