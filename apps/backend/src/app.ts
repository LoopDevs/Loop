import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { logger as honoLogger } from 'hono/logger';
import { sentry, captureException } from '@sentry/hono/node';
import { env } from './env.js';
import { getLocations, isLocationLoading } from './clustering/data-store.js';
import { getMerchants } from './merchants/sync.js';
import { clustersHandler } from './clustering/handler.js';
import { imageProxyHandler, evictExpiredImageCache } from './images/proxy.js';
import { upstreamUrl } from './upstream.js';
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

/** Simple per-IP rate limiter. Returns 429 if limit exceeded within the window. */
function rateLimit(
  maxRequests: number,
  windowMs: number,
): (c: Context, next: () => Promise<void>) => Promise<void | Response> {
  return async (c, next): Promise<void | Response> => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (entry === undefined || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
      if (entry.count > maxRequests) {
        // Tell the client when the window resets so clients can back off
        // instead of hot-looping retries.
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        c.header('Retry-After', String(retryAfterSec));
        return c.json({ code: 'RATE_LIMITED', message: 'Too many requests' }, 429);
      }
    }

    await next();
  };
}

// ─── Global middleware ────────────────────────────────────────────────────────

app.use(
  '*',
  cors({
    origin:
      env.NODE_ENV === 'production'
        ? ['https://loopfinance.io', 'https://www.loopfinance.io']
        : '*',
  }),
);
app.use(
  '*',
  secureHeaders({
    crossOriginResourcePolicy: env.NODE_ENV === 'production' ? 'same-origin' : 'cross-origin',
  }),
);
app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
app.use('*', requestId());
app.use('*', honoLogger());

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
app.delete('/api/auth/session', logoutHandler);

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
