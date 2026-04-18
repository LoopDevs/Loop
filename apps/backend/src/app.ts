import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { logger as honoLogger } from 'hono/logger';
import { getConnInfo } from '@hono/node-server/conninfo';
import { sentry, captureException } from '@sentry/hono/node';
import { env } from './env.js';
import { getLocations, isLocationLoading } from './clustering/data-store.js';
import { getMerchants } from './merchants/sync.js';
import { clustersHandler } from './clustering/handler.js';
import { imageProxyHandler, evictExpiredImageCache } from './images/proxy.js';
import { upstreamUrl } from './upstream.js';
import { getAllCircuitStates } from './circuit-breaker.js';
import { generateOpenApiSpec } from './openapi.js';
import {
  merchantListHandler,
  merchantBySlugHandler,
  merchantDetailHandler,
} from './merchants/handler.js';
import {
  requestOtpHandler,
  verifyOtpHandler,
  refreshHandler,
  logoutHandler,
  requireAuth,
} from './auth/handler.js';
import { createOrderHandler, listOrdersHandler, getOrderHandler } from './orders/handler.js';
import { notifyHealthChange } from './discord.js';

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
app.use('*', honoLogger());

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
app.use('*', async (c, next) => {
  await next();
  // Skip the metrics endpoint itself so we don't count our own scraper.
  if (c.req.path === '/metrics') return;
  const route = c.req.routePath ?? c.req.path;
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

  lines.push('# HELP loop_circuit_state Circuit breaker state per upstream endpoint.');
  lines.push('# HELP loop_circuit_state 0=closed,1=half_open,2=open.');
  lines.push('# TYPE loop_circuit_state gauge');
  for (const [key, state] of Object.entries(getAllCircuitStates())) {
    const val = state === 'closed' ? 0 : state === 'half_open' ? 1 : 2;
    lines.push(`loop_circuit_state{endpoint="${key}"} ${val}`);
  }

  return c.text(lines.join('\n') + '\n', 200, { 'Content-Type': 'text/plain; version=0.0.4' });
});

// ─── OpenAPI spec ─────────────────────────────────────────────────────────────

// Generate once at module load. The spec is a pure function of the zod
// registrations in openapi.ts — it does not depend on runtime state — so
// serializing on every request would just burn CPU.
const openApiSpec = generateOpenApiSpec();
app.get('/openapi.json', (c) =>
  c.json(openApiSpec, 200, { 'Cache-Control': 'public, max-age=3600' }),
);

// ─── Health ───────────────────────────────────────────────────────────────────

let lastHealthStatus: 'healthy' | 'degraded' | null = null;

app.get('/health', async (c) => {
  const { locations, loadedAt: locLoadedAt } = getLocations();
  const { merchants, loadedAt: merLoadedAt } = getMerchants();

  // Check staleness — data older than 2x the refresh interval is stale
  const now = Date.now();
  const merchantStaleMs = env.REFRESH_INTERVAL_HOURS * 2 * 60 * 60 * 1000;
  const locationStaleMs = env.LOCATION_REFRESH_INTERVAL_HOURS * 2 * 60 * 60 * 1000;
  const merchantsStale = now - merLoadedAt > merchantStaleMs;
  const locationsStale = now - locLoadedAt > locationStaleMs;

  // Quick upstream probe (non-blocking, 3s timeout)
  let upstreamReachable = true;
  try {
    const res = await fetch(upstreamUrl('/status'), { signal: AbortSignal.timeout(3000) });
    upstreamReachable = res.ok;
  } catch {
    upstreamReachable = false;
  }

  const degraded = merchantsStale || locationsStale || !upstreamReachable;

  const currentStatus = degraded ? 'degraded' : 'healthy';
  if (lastHealthStatus !== null && lastHealthStatus !== currentStatus) {
    const details = degraded
      ? `Merchants stale: ${merchantsStale}, Locations stale: ${locationsStale}, Upstream: ${upstreamReachable ? 'up' : 'DOWN'}`
      : 'All systems operational';
    notifyHealthChange(currentStatus, details);
  }
  lastHealthStatus = currentStatus;

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

// ─── Image proxy ──────────────────────────────────────────────────────────────

// 300 requests per IP per minute — images load progressively (lazy + cached), not all at once
app.get('/api/image', rateLimit(300, 60_000), imageProxyHandler);

// ─── Merchants ────────────────────────────────────────────────────────────────

app.get('/api/merchants', merchantListHandler);
app.get('/api/merchants/by-slug/:slug', merchantBySlugHandler); // must be before /:id
app.get('/api/merchants/:id', merchantDetailHandler);

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/request-otp', rateLimit(5, 60_000), requestOtpHandler);
// OTP brute-force defense: 10 attempts per minute per IP. With a 6-digit code
// that caps guesses at ~14,400/day — upstream lockout/expiry happens first.
app.post('/api/auth/verify-otp', rateLimit(10, 60_000), verifyOtpHandler);
// Refresh abuse defense: legit clients refresh once per access-token lifetime,
// so 30/min per IP leaves plenty of headroom without enabling spray attacks.
app.post('/api/auth/refresh', rateLimit(30, 60_000), refreshHandler);
// Logout: 20/min per IP. The handler fans out to an upstream revoke, so
// without a limit an attacker could cheaply spam arbitrary refresh tokens
// at CTX through us.
app.delete('/api/auth/session', rateLimit(20, 60_000), logoutHandler);

// ─── Orders (authenticated) ───────────────────────────────────────────────────

app.use('/api/orders', requireAuth);
app.use('/api/orders/*', requireAuth);
app.post('/api/orders', createOrderHandler);
app.get('/api/orders', listOrdersHandler);
app.get('/api/orders/:id', getOrderHandler);

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
