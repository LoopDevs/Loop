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
import { adminConfigsHistoryHandler } from './admin/configs-history.js';
import { treasuryHandler } from './admin/treasury.js';
import { adminTreasuryCreditFlowHandler } from './admin/treasury-credit-flow.js';
import {
  adminGetPayoutHandler,
  adminListPayoutsHandler,
  adminPayoutByOrderHandler,
  adminRetryPayoutHandler,
} from './admin/payouts.js';
import { adminPayoutsCsvHandler } from './admin/payouts-csv.js';
import { adminPayoutsByAssetHandler } from './admin/payouts-by-asset.js';
import { adminTopUsersHandler } from './admin/top-users.js';
import { adminTopUsersByPendingPayoutHandler } from './admin/top-users-by-pending-payout.js';
import { adminUsersRecyclingActivityHandler } from './admin/users-recycling-activity.js';
import { adminUsersRecyclingActivityCsvHandler } from './admin/users-recycling-activity-csv.js';
import { adminAuditTailHandler } from './admin/audit-tail.js';
import { adminAuditTailCsvHandler } from './admin/audit-tail-csv.js';
import { adminGetOrderHandler, adminListOrdersHandler } from './admin/orders.js';
import { adminOrdersActivityHandler } from './admin/orders-activity.js';
import { adminPaymentMethodShareHandler } from './admin/payment-method-share.js';
import { adminPaymentMethodActivityHandler } from './admin/payment-method-activity.js';
import { adminOrdersCsvHandler } from './admin/orders-csv.js';
import { adminStuckOrdersHandler } from './admin/stuck-orders.js';
import { adminStuckPayoutsHandler } from './admin/stuck-payouts.js';
import { adminCashbackActivityHandler } from './admin/cashback-activity.js';
import { adminCashbackActivityCsvHandler } from './admin/cashback-activity-csv.js';
import { adminCashbackMonthlyHandler } from './admin/cashback-monthly.js';
import { adminPayoutsMonthlyHandler } from './admin/payouts-monthly.js';
import { adminPayoutsActivityHandler } from './admin/payouts-activity.js';
import { adminPayoutsActivityCsvHandler } from './admin/payouts-activity-csv.js';
import { adminSupplierSpendActivityCsvHandler } from './admin/supplier-spend-activity-csv.js';
import { adminOperatorsSnapshotCsvHandler } from './admin/operators-snapshot-csv.js';
import { adminTreasuryCreditFlowCsvHandler } from './admin/treasury-credit-flow-csv.js';
import { adminMerchantStatsHandler } from './admin/merchant-stats.js';
import { adminMerchantStatsCsvHandler } from './admin/merchant-stats-csv.js';
import { adminMerchantsFlywheelShareHandler } from './admin/merchants-flywheel-share.js';
import { adminMerchantsFlywheelShareCsvHandler } from './admin/merchants-flywheel-share-csv.js';
import { adminMerchantFlywheelStatsHandler } from './admin/merchant-flywheel-stats.js';
import { adminMerchantCashbackSummaryHandler } from './admin/merchant-cashback-summary.js';
import { adminMerchantPaymentMethodShareHandler } from './admin/merchant-payment-method-share.js';
import { adminMerchantCashbackMonthlyHandler } from './admin/merchant-cashback-monthly.js';
import { adminMerchantFlywheelActivityHandler } from './admin/merchant-flywheel-activity.js';
import { adminMerchantFlywheelActivityCsvHandler } from './admin/merchant-flywheel-activity-csv.js';
import { adminMerchantTopEarnersHandler } from './admin/merchant-top-earners.js';
import { adminCashbackConfigsCsvHandler } from './admin/cashback-configs-csv.js';
import { adminMerchantsCatalogCsvHandler } from './admin/merchants-catalog-csv.js';
import { adminSupplierSpendHandler } from './admin/supplier-spend.js';
import { adminSupplierSpendActivityHandler } from './admin/supplier-spend-activity.js';
import { adminOperatorSupplierSpendHandler } from './admin/operator-supplier-spend.js';
import { adminOperatorActivityHandler } from './admin/operator-activity.js';
import { adminOperatorStatsHandler } from './admin/operator-stats.js';
import { adminOperatorLatencyHandler } from './admin/operator-latency.js';
import { adminMerchantOperatorMixHandler } from './admin/merchant-operator-mix.js';
import { adminUserCreditsHandler } from './admin/user-credits.js';
import { adminUserCreditTransactionsHandler } from './admin/user-credit-transactions.js';
import { adminUserCreditTransactionsCsvHandler } from './admin/user-credit-transactions-csv.js';
import { adminUserCashbackByMerchantHandler } from './admin/user-cashback-by-merchant.js';
import { adminUserCashbackSummaryHandler } from './admin/user-cashback-summary.js';
import { adminUserFlywheelStatsHandler } from './admin/user-flywheel-stats.js';
import { adminUserPaymentMethodShareHandler } from './admin/user-payment-method-share.js';
import { adminUserCashbackMonthlyHandler } from './admin/user-cashback-monthly.js';
import { adminGetUserHandler } from './admin/user-detail.js';
import { adminUserByEmailHandler } from './admin/user-by-email.js';
import { adminListUsersHandler } from './admin/users-list.js';
import { adminMerchantsResyncHandler } from './admin/merchants-resync.js';
import { adminDiscordNotifiersHandler } from './admin/discord-notifiers.js';
import { adminDiscordTestHandler } from './admin/discord-test.js';
import { adminCreditAdjustmentHandler } from './admin/credit-adjustments.js';
import { publicCashbackStatsHandler } from './public/cashback-stats.js';
import { publicFlywheelStatsHandler } from './public/flywheel-stats.js';
import { publicLoopAssetsHandler } from './public/loop-assets.js';
import { publicTopCashbackMerchantsHandler } from './public/top-cashback-merchants.js';
import { publicMerchantHandler } from './public/merchant.js';
import {
  getCashbackHistoryHandler,
  getCashbackSummaryHandler,
  getMeHandler,
  getUserCreditsHandler,
  getUserPendingPayoutDetailHandler,
  getUserPendingPayoutsHandler,
  setHomeCurrencyHandler,
  setStellarAddressHandler,
} from './users/handler.js';
import { getCashbackByMerchantHandler } from './users/cashback-by-merchant.js';
import { getCashbackMonthlyHandler } from './users/cashback-monthly.js';
import { getUserOrdersSummaryHandler } from './users/orders-summary.js';
import { getUserFlywheelStatsHandler } from './users/flywheel-stats.js';
import { getUserPaymentMethodShareHandler } from './users/payment-method-share.js';

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
    // Escape hatch for e2e test runs. The mocked-e2e suite drives
    // the purchase flow twice with Playwright retries, which
    // collides with the 5/min request-otp limit on a cold start.
    // Setting DISABLE_RATE_LIMITING=1 lets the harness bypass the
    // limiter without tripping the unit tests that explicitly
    // verify the 429 path under NODE_ENV=test. Production never
    // sets this flag.
    if (env.DISABLE_RATE_LIMITING) {
      await next();
      return;
    }
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

// Public, unauthenticated, marketing-facing cashback totals. 60/min
// per IP is generous for a landing-page widget that renders once
// per visit; edge-cache respects the handler's Cache-Control so real
// origin load will be much lower.
app.get('/api/public/cashback-stats', rateLimit(60, 60_000), publicCashbackStatsHandler);
// Public, unauthenticated, CDN-friendly "best cashback" list for the
// landing page. Same never-500 + Cache-Control discipline as the
// cashback-stats endpoint (ADR 020).
app.get(
  '/api/public/top-cashback-merchants',
  rateLimit(60, 60_000),
  publicTopCashbackMerchantsHandler,
);
// Per-merchant unauthenticated detail (#647) — backs the SEO
// landing pages at /cashback/:merchant-slug. Accepts merchant
// id OR slug so SSR can pass whichever form is on the URL.
// Same never-500 / cache-control discipline as the other
// public endpoints (ADR 020).
app.get('/api/public/merchants/:id', rateLimit(60, 60_000), publicMerchantHandler);
// LOOP-asset transparency surface (ADR 015 / 020). Public list of
// configured (code, issuer) pairs so third-party wallets + users can
// add trustlines to the verified issuer accounts without guessing
// from on-chain traffic.
app.get('/api/public/loop-assets', rateLimit(60, 60_000), publicLoopAssetsHandler);
// Marketing flywheel scalar — % of fulfilled orders in the last 30
// days paid via LOOP-asset cashback. Complement to
// /api/public/cashback-stats (emission) with the recycle side of
// the story. Never-500; 300s cache on happy path, 60s on fallback.
app.get('/api/public/flywheel-stats', rateLimit(60, 60_000), publicFlywheelStatsHandler);

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
// GET /api/users/me/credits — caller's off-chain cashback balance per
// currency (ADR 009 / 015). /me surfaces a single scalar in the user's
// home currency; this is the multi-currency complement for users who
// have flipped home currency or received a non-home adjustment.
app.get('/api/users/me/credits', rateLimit(60, 60_000), getUserCreditsHandler);
// GET /api/users/me/pending-payouts — caller-scoped on-chain payout
// rows (ADR 015 / 016). 60/min matches the history endpoint; clients
// typically poll this from /settings/cashback while a payout is in
// flight. State + before + limit query shape mirrors the admin endpoint.
app.get('/api/users/me/pending-payouts', rateLimit(60, 60_000), getUserPendingPayoutsHandler);
// GET /api/users/me/pending-payouts/:id — caller-scoped single
// drill-down. Cross-user access returns 404 (not 403) so payout
// ids aren't enumerable.
app.get(
  '/api/users/me/pending-payouts/:id',
  rateLimit(120, 60_000),
  getUserPendingPayoutDetailHandler,
);
// GET /api/users/me/cashback-summary — compact lifetime + this-month
// cashback totals in the user's home currency. Powers the home-page
// headline ("£42 earned · £3.20 this month") without paging the
// whole credit_transactions ledger.
app.get('/api/users/me/cashback-summary', rateLimit(60, 60_000), getCashbackSummaryHandler);
// GET /api/users/me/cashback-by-merchant — user's top cashback-earning
// merchants in a rolling window. Powers the "earned by merchant" card
// on /settings/cashback so users see which merchants drive their
// cashback accrual without scrolling the full ledger (ADR 009/015).
app.get('/api/users/me/cashback-by-merchant', rateLimit(60, 60_000), getCashbackByMerchantHandler);
// Last-12-months cashback totals for the caller, grouped by (month,
// currency). Drives the monthly bar chart on /settings/cashback —
// answers "how did this month compare to last?" without hitting the
// full ledger endpoint on the client (ADR 009/015).
app.get('/api/users/me/cashback-monthly', rateLimit(60, 60_000), getCashbackMonthlyHandler);
// 5-number summary header for /orders: total, fulfilled, pending,
// failed, lifetime spend. Companion to /cashback-summary; single
// query with FILTER-ed COUNT/SUM so the /orders page doesn't hit
// the list endpoint just to render a header (ADR 010).
app.get('/api/users/me/orders/summary', rateLimit(60, 60_000), getUserOrdersSummaryHandler);
// Personal flywheel stats — how many of the caller's fulfilled
// orders they paid for with LOOP asset (recycled cashback), vs
// the total fulfilled denominator. Powers a motivational chip on
// /orders: "You've recycled £X of cashback across Y orders". User-
// side mirror of /api/admin/orders/payment-method-share. One query.
app.get('/api/users/me/flywheel-stats', rateLimit(60, 60_000), getUserFlywheelStatsHandler);
// User-facing rail mix (#643) — self-view of the caller's own
// orders-by-payment-method, home-currency locked. Drives a
// forthcoming "your rail mix" card on /settings/cashback so
// users can see their own LOOP-asset share and the app can
// nudge toward LOOP for compounding cashback. Same zero-fill +
// default ?state=fulfilled as the admin siblings.
app.get(
  '/api/users/me/payment-method-share',
  rateLimit(60, 60_000),
  getUserPaymentMethodShareHandler,
);

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
// CSV export of merchant_cashback_configs — Tier-3 bulk per ADR 018.
// 10/min rate-limit matches the other admin CSVs; ops runs this at
// audit cadence, not on-click from the UI. Registered before the
// :merchantId routes below so the literal `.csv` segment isn't
// treated as a merchantId.
app.get(
  '/api/admin/merchant-cashback-configs.csv',
  rateLimit(10, 60_000),
  adminCashbackConfigsCsvHandler,
);
// Tier-3 CSV export of the full merchant catalog + joined
// cashback-config state (#653). Finance / BD runs this to see
// every merchant + current commercial terms in one spreadsheet.
// Catalog is the source of truth — evicted merchants drop out,
// stale config rows are filtered out by the join.
app.get('/api/admin/merchants-catalog.csv', rateLimit(10, 60_000), adminMerchantsCatalogCsvHandler);
// Fleet-wide history feed — "the last N config changes across every
// merchant". Registered before /:merchantId/history so the literal
// `history` segment isn't captured as a merchantId. ADR 011 / 018.
app.get(
  '/api/admin/merchant-cashback-configs/history',
  rateLimit(120, 60_000),
  adminConfigsHistoryHandler,
);
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
// Treasury credit-flow time-series (ADR 009/015) — per-day credited
// vs debited per currency from credit_transactions. Answers "are we
// generating liability faster than we settle it?" — the dynamic
// view the treasury snapshot can't give.
app.get('/api/admin/treasury/credit-flow', rateLimit(60, 60_000), adminTreasuryCreditFlowHandler);
// Pending-payouts backlog list (ADR 015). Admin UI's "payouts" page
// drills into pending/submitted/confirmed/failed rows; counts for the
// at-a-glance card come from the treasury snapshot above.
app.get('/api/admin/payouts', rateLimit(60, 60_000), adminListPayoutsHandler);
// GET /api/admin/payouts/:id — single-row drill-down (permalink for
// an ops ticket / incident note). Higher rate limit than the list
// because the admin UI deep-links individual rows on every navigation.
app.get('/api/admin/payouts/:id', rateLimit(120, 60_000), adminGetPayoutHandler);
// Per-asset payout breakdown — crosses asset_code × state for the
// LOOP stablecoin triage view (ADR 015/016). Admin UI renders this
// on the treasury page as a per-asset table next to the flat payout
// list, so an incident in one asset doesn't get lost in the volume
// of another.
app.get('/api/admin/payouts-by-asset', rateLimit(60, 60_000), adminPayoutsByAssetHandler);
// POST /api/admin/payouts/:id/retry — flip a failed row back to pending.
// Lower rate limit: retries should be rare, one-at-a-time ops actions.
app.post('/api/admin/payouts/:id/retry', rateLimit(20, 60_000), adminRetryPayoutHandler);
// Finance-ready CSV export of pending_payouts rows. Lower rate
// limit than the JSON list because exports scan rows 500× the
// size of a pagination fetch.
app.get('/api/admin/payouts.csv', rateLimit(10, 60_000), adminPayoutsCsvHandler);
// Loop-native orders drill-down (ADR 011 / 015). Paginated, filterable
// by state and userId. Ops uses this to triage stuck orders + audit
// the cashback split + correlate with operator-pool health.
app.get('/api/admin/orders', rateLimit(60, 60_000), adminListOrdersHandler);
// 7-day (or N-day, clamped 1-90) order-activity sparkline. Drives the
// admin dashboard's "created vs fulfilled per day" chart. Single
// generate_series + LEFT JOIN; every day in the window appears with
// zero-filled counts when no orders crossed. Registered before
// `/:orderId` so the literal `/activity` matches first.
app.get('/api/admin/orders/activity', rateLimit(60, 60_000), adminOrdersActivityHandler);
// Payment-method share aggregate — the cashback-flywheel metric.
// Tracks the proportion of orders paid with each rail (xlm / usdc /
// credit / loop_asset). ADR 010 / 015's strategy assumes a rising
// loop_asset share once users have cashback to recycle; this is how
// ops reads that. Registered before /:orderId so the literal
// 'payment-method-share' doesn't get captured as an orderId.
app.get(
  '/api/admin/orders/payment-method-share',
  rateLimit(60, 60_000),
  adminPaymentMethodShareHandler,
);
// Time-series complement to /payment-method-share. Same four-rail
// shape but bucketed per UTC day, capped at 90d, so the trend side
// of the flywheel signal is observable — share is "where are we
// now", activity is "where are we going". Registered before
// /:orderId for the same literal-vs-param reason as its sibling.
app.get(
  '/api/admin/orders/payment-method-activity',
  rateLimit(60, 60_000),
  adminPaymentMethodActivityHandler,
);
// Single-order drill-down (ADR 011 / 015). Permalink for an ops
// ticket or incident note. Higher rate-limit than the list because
// the admin UI re-fetches detail on every navigation.
app.get('/api/admin/orders/:orderId', rateLimit(120, 60_000), adminGetOrderHandler);
// Finance-ready CSV export of Loop-native orders. Same rate-limit
// cadence as other Tier-3 exports — ops runs it manually at month-end,
// not on-click from the UI.
app.get('/api/admin/orders.csv', rateLimit(10, 60_000), adminOrdersCsvHandler);
// Stuck-orders triage. Dashboard pings this every 30-60s — higher
// rate limit because the admin UI polls it on a loop to surface
// an SLO red-flag card.
app.get('/api/admin/stuck-orders', rateLimit(120, 60_000), adminStuckOrdersHandler);
// Stuck-payouts triage — pending_payouts rows in pending/submitted
// past the SLO threshold (ADR 015/016). Same 120/min polling budget
// as stuck-orders since both feed the same dashboard card and often
// refetch together.
app.get('/api/admin/stuck-payouts', rateLimit(120, 60_000), adminStuckPayoutsHandler);
// Daily cashback-accrual time-series for the dashboard sparkline.
// Cheap read — single generate_series + LEFT JOIN, bounded at 180
// days so the payload can't explode.
app.get('/api/admin/cashback-activity', rateLimit(60, 60_000), adminCashbackActivityHandler);
// Finance-ready CSV: daily × per-currency cashback accrual. Same
// aggregate as the JSON surface, flattened for spreadsheet use.
// Tier-3 rate limit — month-end finance use, not polling.
app.get('/api/admin/cashback-activity.csv', rateLimit(10, 60_000), adminCashbackActivityCsvHandler);
// Fleet-wide monthly-cashback bar chart — per-(month, currency)
// emission totals over a fixed 12-month window. Mirrors the user-
// facing /api/users/me/cashback-monthly shape so the same chart
// component can render either. Single aggregate query.
app.get('/api/admin/cashback-monthly', rateLimit(60, 60_000), adminCashbackMonthlyHandler);
// Monthly confirmed-payout totals (#631) — settlement-side
// counterpart to cashback-monthly. Cashback-monthly measures
// liability creation (credits minted); this measures liability
// settlement (confirmed on-chain payouts). Pairing the two
// answers "is outstanding liability growing or shrinking this
// month?". Same 12-month window + oldest-first ordering.
app.get('/api/admin/payouts-monthly', rateLimit(60, 60_000), adminPayoutsMonthlyHandler);
// Daily payouts-activity (#637) — settlement-side sparkline
// counterpart to cashback-activity. Same ?days window (default
// 30, max 180), LEFT-JOIN generate_series so zero-days render
// as empty byAsset[]. Drives the payout-trend sparkline on
// /admin/treasury.
app.get('/api/admin/payouts-activity', rateLimit(60, 60_000), adminPayoutsActivityHandler);
// Tier-3 CSV export of the same aggregate (#638) — finance runs
// this alongside /api/admin/cashback-activity.csv at month-end
// to reconcile liability creation vs. settlement. Rate-limited
// 10/min per ADR 018.
app.get('/api/admin/payouts-activity.csv', rateLimit(10, 60_000), adminPayoutsActivityCsvHandler);
// Tier-3 CSV export of supplier-spend activity (ADR 013/015/018) —
// finance runs this at month-end to reconcile CTX's invoice: the
// wholesale_minor column per (day, currency) should tie to CTX's
// line items. Pairs with cashback-activity.csv (what we minted)
// and payouts-activity.csv (what we settled).
app.get(
  '/api/admin/supplier-spend/activity.csv',
  rateLimit(10, 60_000),
  adminSupplierSpendActivityCsvHandler,
);
// Tier-3 CSV of the fleet operator snapshot (ADR 013 / 018 / 022)
// — joins operator-stats + operator-latency into one row per
// operator. Handed to CTX relationship owners for quarterly
// review meetings (SLA + volume + success rate on one sheet).
app.get(
  '/api/admin/operators-snapshot.csv',
  rateLimit(10, 60_000),
  adminOperatorsSnapshotCsvHandler,
);
// Tier-3 CSV of the credit-flow time series (ADR 009 / 015 / 018).
// Completes the finance-CSV quartet: cashback-activity (minted) +
// payouts-activity (settled on-chain) + supplier-spend/activity
// (paid to CTX) + this (net ledger movement).
app.get(
  '/api/admin/treasury/credit-flow.csv',
  rateLimit(10, 60_000),
  adminTreasuryCreditFlowCsvHandler,
);
// Per-merchant cashback stats — which merchants drive volume /
// cashback outlay / margin. Distinct from supplier-spend (currency
// grouped) — this one groups by merchant.
app.get('/api/admin/merchant-stats', rateLimit(60, 60_000), adminMerchantStatsHandler);
// Per-merchant × per-operator mix (ADR 013 / 022). The
// merchant-axis complement to operator-stats: lives under
// /merchants/:merchantId so an incident triage landing on
// /admin/merchants/:id can ask "which operator is primarily
// carrying this merchant right now?". Complements the fleet
// operator-stats + the per-operator drill quartet.
app.get(
  '/api/admin/merchants/:merchantId/operator-mix',
  rateLimit(120, 60_000),
  adminMerchantOperatorMixHandler,
);
// Finance / negotiation CSV — flattened per-merchant stats for
// the CTX rate-deck spreadsheet. Tier-3 rate limit matches the
// other admin CSV exports.
app.get('/api/admin/merchant-stats.csv', rateLimit(10, 60_000), adminMerchantStatsCsvHandler);
// Per-merchant flywheel leaderboard — which merchants see the most
// recycled-cashback traffic. Merchant-axis cousin of /orders/payment-
// method-share (fleet) + /orders/payment-method-activity (time).
// Zero-recycle merchants filtered out; sorted by recycled-count desc.
app.get(
  '/api/admin/merchants/flywheel-share',
  rateLimit(60, 60_000),
  adminMerchantsFlywheelShareHandler,
);
// Tier-3 CSV snapshot of the merchant flywheel leaderboard —
// finance / CTX-negotiation export. Same aggregate as the JSON,
// flattened for spreadsheet consumption. 10/min rate limit matches
// every other admin CSV.
app.get(
  '/api/admin/merchants/flywheel-share.csv',
  rateLimit(10, 60_000),
  adminMerchantsFlywheelShareCsvHandler,
);
// Per-merchant scalar flywheel stats — the single-merchant drill
// mirror of the fleet leaderboard. Drives a chip on the
// /admin/merchants/:merchantId page. Registered after the literal
// `/flywheel-share` + `.csv` paths so Hono's matcher resolves
// static > dynamic correctly.
app.get(
  '/api/admin/merchants/:merchantId/flywheel-stats',
  rateLimit(120, 60_000),
  adminMerchantFlywheelStatsHandler,
);
// Per-merchant cashback-summary (#625) — per-currency lifetime
// user_cashback_minor on fulfilled orders. Sibling of the per-user
// variant; drives the "cashback paid out" card on the merchant
// drill-down. Registered after the literal `/flywheel-share` +
// `.csv` paths so Hono resolves static > dynamic.
app.get(
  '/api/admin/merchants/:merchantId/cashback-summary',
  rateLimit(120, 60_000),
  adminMerchantCashbackSummaryHandler,
);
// Per-merchant payment-method share (#627) — rail mix on one
// merchant. Sibling of `/api/admin/orders/payment-method-share`,
// scoped via WHERE merchant_id = :merchantId. Drives a small
// "rail mix" card on the merchant drill alongside flywheel +
// cashback-paid. Default ?state=fulfilled, zero-filled across
// every known payment method for stable layout.
app.get(
  '/api/admin/merchants/:merchantId/payment-method-share',
  rateLimit(120, 60_000),
  adminMerchantPaymentMethodShareHandler,
);
// Per-merchant cashback-monthly (#635) — 12-month per-(month,
// currency) user_cashback_minor emission trend for one merchant.
// Sibling of /api/admin/cashback-monthly (fleet) and
// /api/admin/users/:userId/cashback-monthly (#633). Drives the
// forthcoming `MerchantCashbackMonthlyChart` on the merchant
// drill alongside the scalar cashback-paid-out card.
app.get(
  '/api/admin/merchants/:merchantId/cashback-monthly',
  rateLimit(120, 60_000),
  adminMerchantCashbackMonthlyHandler,
);
// Per-merchant flywheel-activity time-series (#641) — daily
// recycled-vs-total fulfilled-order counts. Time-axis companion
// to the scalar /flywheel-stats endpoint from #623; drives the
// forthcoming sparkline on /admin/merchants/:merchantId so ops
// can see whether LOOP-asset adoption at a merchant is rising
// or plateaued over time.
app.get(
  '/api/admin/merchants/:merchantId/flywheel-activity',
  rateLimit(120, 60_000),
  adminMerchantFlywheelActivityHandler,
);
// Tier-3 CSV export of the same per-merchant flywheel-activity
// aggregate (#645). Finance / BD runs this when prepping a
// commercial conversation with a merchant or negotiating
// cashback-rate changes against observed recycling behaviour.
// Rate-limited 10/min per ADR 018.
app.get(
  '/api/admin/merchants/:merchantId/flywheel-activity.csv',
  rateLimit(10, 60_000),
  adminMerchantFlywheelActivityCsvHandler,
);
// Per-merchant top-earners leaderboard (#655) — ranked list of
// users who earned the most cashback at one merchant in the
// window. Inverse axis of user-cashback-by-merchant (per-user
// view asks "where did Alice earn?"; this asks "who earns at
// Amazon?"). Drives a "Top earners" card on the merchant drill
// so BD/support can target outreach to whales at a specific
// merchant. Joins against users for email enrichment — admin-
// gated, so email is fine in the response.
app.get(
  '/api/admin/merchants/:merchantId/top-earners',
  rateLimit(120, 60_000),
  adminMerchantTopEarnersHandler,
);
// Given an order id, return the single pending_payouts row for it.
// Nested under /orders/:orderId so the UI can link from the order
// drill-down straight to the payout state without a separate fetch.
app.get('/api/admin/orders/:orderId/payout', rateLimit(120, 60_000), adminPayoutByOrderHandler);
// Supplier-spend snapshot (ADR 013 / 015): per-currency aggregate of
// what Loop paid CTX across fulfilled orders in the window. Admin UI
// renders this on the treasury page as the "supplier" card next to
// outstanding liabilities.
app.get('/api/admin/supplier-spend', rateLimit(60, 60_000), adminSupplierSpendHandler);
// Supplier-spend activity time-series (ADR 013 / 015) — per-day
// per-currency wholesale/face/cashback/margin paid to CTX. The
// time-axis of the supplier-spend snapshot. Together with
// credit-flow (ledger in) and payouts-activity (chain out) this
// completes the three treasury-velocity feeds ops watches to
// know money moved as expected today.
app.get(
  '/api/admin/supplier-spend/activity',
  rateLimit(60, 60_000),
  adminSupplierSpendActivityHandler,
);
// Per-operator supplier-spend (#674) — per-currency aggregate
// scoped to one CTX operator. Answers "which operator drove the
// supplier spend?" — the ADR-022 per-operator axis of the fleet-
// wide supplier-spend. Ops uses this to spot load-balancing
// drift: one operator suddenly carrying 80% of spend is a
// scheduler / circuit-breaker signal.
app.get(
  '/api/admin/operators/:operatorId/supplier-spend',
  rateLimit(120, 60_000),
  adminOperatorSupplierSpendHandler,
);
// Per-operator daily activity time-series (ADR 013 / 022) —
// completes the operator-drill quartet alongside operator-stats
// (fleet snapshot), operators/latency (fleet percentiles) and
// operators/:id/supplier-spend (per-operator cost). Answers "is
// this operator degrading?" — a rising `failed` line or a
// dropping fulfilled/created ratio is a scheduler-tuning /
// CTX-escalation signal before the circuit breaker trips.
app.get(
  '/api/admin/operators/:operatorId/activity',
  rateLimit(120, 60_000),
  adminOperatorActivityHandler,
);
// Per-operator breakdown of which CTX service account carried which
// orders (ADR 013). Complements supplier-spend: spend is *what* Loop
// paid CTX per currency, operator-stats is *which operator* carried
// the traffic — the two answer different questions during an
// incident so they live side-by-side on the treasury page.
app.get('/api/admin/operator-stats', rateLimit(60, 60_000), adminOperatorStatsHandler);
// Per-operator fulfilment latency (ADR 013 / 022): p50/p95/p99 of
// `fulfilledAt - paidAt` per operator in the window. Operator-stats
// above tells ops *which* operator is busy; this tells them *which
// is slow*. A busy operator with rising p95 is the early signal
// before the circuit breaker trips.
app.get('/api/admin/operators/latency', rateLimit(60, 60_000), adminOperatorLatencyHandler);
// Top users by cashback earned — recognition + concentration-risk
// view for ops. Ranked, window-bounded; not a drill path.
app.get('/api/admin/top-users', rateLimit(60, 60_000), adminTopUsersHandler);
// Newest-first tail of admin_idempotency_keys (ADR 017/018). Powers
// the "recent admin activity" card on the /admin landing. Same row
// as the Discord audit fanout but persistent + queryable. Actor
// email joined in so the UI doesn't need a follow-up lookup.
app.get('/api/admin/audit-tail', rateLimit(60, 60_000), adminAuditTailHandler);
// Finance / legal CSV export of the admin write-audit trail
// (ADR 017 / 018). SOC-2 and finance audits want a month of
// rows exportable in a neutral format. 10/min rate-limit mirrors
// the other Tier-3 CSV exports — ops runs this manually at
// month-end, not on-click from the UI.
app.get('/api/admin/audit-tail.csv', rateLimit(10, 60_000), adminAuditTailCsvHandler);
// Paginated user directory — browse + search for the admin panel.
// Complements the exact-by-id drill at /api/admin/users/:userId.
app.get('/api/admin/users', rateLimit(60, 60_000), adminListUsersHandler);
// Exact-match email lookup — support pastes the full address from a
// ticket, gets the user id back in one request. Different lookup
// mode from the fragment search above; registered before
// /:userId so the literal 'by-email' segment isn't captured as a
// uuid param.
app.get('/api/admin/users/by-email', rateLimit(60, 60_000), adminUserByEmailHandler);
// Ops funding prioritisation — "who's owed the most USDLOOP right
// now?". Grouped by (user, asset) over pending + submitted payout
// rows; complements /api/admin/top-users (which ranks by lifetime
// earnings). Registered before /:userId so the literal
// 'top-by-pending-payout' segment isn't treated as a uuid param.
app.get(
  '/api/admin/users/top-by-pending-payout',
  rateLimit(60, 60_000),
  adminTopUsersByPendingPayoutHandler,
);
// "Who's recycling right now?" — 90-day list of users with at least
// one loop_asset order, ranked by most-recent recycle. Complement to
// /top-users (by cashback earned) and /top-by-pending-payout (by
// backlog). Registered before /:userId so the literal segment is
// not captured as a uuid.
app.get(
  '/api/admin/users/recycling-activity',
  rateLimit(60, 60_000),
  adminUsersRecyclingActivityHandler,
);
// Tier-3 CSV snapshot of the user recycling leaderboard —
// finance-grade export for ops. Registered before /:userId (same
// literal-vs-uuid routing constraint as the JSON sibling) and
// follows the ADR-018 CSV conventions (10/min rate limit, 10k row
// cap with `__TRUNCATED__` sentinel, attachment disposition).
app.get(
  '/api/admin/users/recycling-activity.csv',
  rateLimit(10, 60_000),
  adminUsersRecyclingActivityCsvHandler,
);
// Admin user-detail drill. Entry point for the admin panel's user
// page — subsequent drills (credits, credit-transactions, orders)
// all key off the id this endpoint returns.
app.get('/api/admin/users/:userId', rateLimit(120, 60_000), adminGetUserHandler);
// Per-user credit-balance drill-down (ADR 009). Ops opens this from
// a support ticket; complements the treasury aggregate which only
// gives fleet-wide outstanding.
app.get('/api/admin/users/:userId/credits', rateLimit(120, 60_000), adminUserCreditsHandler);
// Per-user cashback-by-merchant breakdown — support triage. Answers
// "user asks why they haven't earned cashback on merchant X" by
// grouping their cashback ledger rows by source-order merchant.
// Default window 180d, cap 366d; default limit 25, cap 100.
app.get(
  '/api/admin/users/:userId/cashback-by-merchant',
  rateLimit(120, 60_000),
  adminUserCashbackByMerchantHandler,
);
// Scalar cashback headline for a user — mirrors the user-facing
// /api/users/me/cashback-summary but admin-scoped to any userId.
// Powers the "£42 lifetime · £3.20 this month" chip on the admin
// user drill-down. Single query; 404 when the user id doesn't
// exist (LEFT JOIN returns no rows in that case).
app.get(
  '/api/admin/users/:userId/cashback-summary',
  rateLimit(120, 60_000),
  adminUserCashbackSummaryHandler,
);
// Per-user flywheel scalar — admin mirror of /api/users/me/flywheel-
// stats. Supports triage questions like "is this user part of the
// recycling loop or just top-ups?". Single LEFT JOIN; 404 on unknown
// userId, zero counts on an existing user with no fulfilled orders.
app.get(
  '/api/admin/users/:userId/flywheel-stats',
  rateLimit(120, 60_000),
  adminUserFlywheelStatsHandler,
);
// Per-user payment-method share (#628 follow-up) — user-scoped
// rail-mix mirror of the fleet + per-merchant siblings. Drives a
// "rail mix" card on the user drill alongside the flywheel chip
// + cashback-summary. Same zero-fill + state-default conventions
// as the other share endpoints.
app.get(
  '/api/admin/users/:userId/payment-method-share',
  rateLimit(120, 60_000),
  adminUserPaymentMethodShareHandler,
);
// Per-user cashback-monthly (#633) — 12-month emission trend for
// one user. Sibling of /api/admin/cashback-monthly and
// /api/users/me/cashback-monthly. Drives the forthcoming
// `UserCashbackMonthlyChart` on the user drill — same visual
// primitives as the fleet chart, scoped to one user. 404 on
// unknown userId; zero entries for an existing user with no
// cashback in the window.
app.get(
  '/api/admin/users/:userId/cashback-monthly',
  rateLimit(120, 60_000),
  adminUserCashbackMonthlyHandler,
);
// Credit-transaction log for a user (ADR 009). Drill-down from the
// balance endpoint — shows how the balance got there (cashback,
// withdrawals, refunds, adjustments).
app.get(
  '/api/admin/users/:userId/credit-transactions',
  rateLimit(120, 60_000),
  adminUserCreditTransactionsHandler,
);
// Finance / compliance / support CSV of one user's credit-ledger
// history. Same Tier-3 rate-limit cadence as the other CSV
// exports — runs at ticket-resolution speed, not on-click from
// the admin UI.
app.get(
  '/api/admin/users/:userId/credit-transactions.csv',
  rateLimit(10, 60_000),
  adminUserCreditTransactionsCsvHandler,
);
// Credit-adjustment write (ADR 017). Lower rate limit than reads —
// it's an explicit ops action, not a polled surface. Idempotency-Key
// header required; missing header is a 400 at the handler edge.
app.post(
  '/api/admin/users/:userId/credit-adjustments',
  rateLimit(20, 60_000),
  adminCreditAdjustmentHandler,
);
// Manual merchant-catalog resync (ADR 011). Bypasses the 6h
// scheduled refresh so ops can apply an upstream catalog change
// within seconds. 2/min rate limit — every hit goes to CTX, this
// is a manual override not a polled surface.
app.post('/api/admin/merchants/resync', rateLimit(2, 60_000), adminMerchantsResyncHandler);
// Discord notifier catalog (ADR 018). Static read of the
// DISCORD_NOTIFIERS const — the admin UI renders "what signals can
// this system send us?" from this list. No DB, no secrets.
app.get('/api/admin/discord/notifiers', rateLimit(60, 60_000), adminDiscordNotifiersHandler);
// Manual Discord test ping. Admin picks a channel, backend fires a
// benign embed at the configured webhook so ops can verify wiring
// after rotating env vars. 10/min — this is a manual ops primitive,
// spamming looks like webhook enumeration.
app.post('/api/admin/discord/test', rateLimit(10, 60_000), adminDiscordTestHandler);

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
