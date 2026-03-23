import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { env } from './env.js';
import { logger } from './logger.js';
import { startLocationRefresh, getLocations } from './clustering/data-store.js';
import { startMerchantRefresh, getMerchants } from './merchants/sync.js';
import { clustersHandler } from './clustering/handler.js';
import { imageProxyHandler, evictExpiredImageCache } from './images/proxy.js';
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

export const app = new Hono();

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
app.use('*', honoLogger());

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (c) => {
  const { locations, loadedAt } = getLocations();
  const { merchants } = getMerchants();
  return c.json({
    status: 'healthy',
    locationCount: locations.length,
    merchantCount: merchants.length,
    loadedAt: new Date(loadedAt).toISOString(),
  });
});

// ─── Map clustering ───────────────────────────────────────────────────────────

app.get('/api/clusters', clustersHandler);

// ─── Image proxy ──────────────────────────────────────────────────────────────

// 60 requests per IP per minute — prevents abuse of upstream fetches + sharp processing
app.get('/api/image', rateLimit(60, 60_000), imageProxyHandler);

// ─── Merchants ────────────────────────────────────────────────────────────────

app.get('/api/merchants', merchantListHandler);
app.get('/api/merchants/by-slug/:slug', merchantBySlugHandler); // must be before /:id
app.get('/api/merchants/:id', merchantDetailHandler);

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/request-otp', rateLimit(5, 60_000), requestOtpHandler);
app.post('/api/auth/verify-otp', verifyOtpHandler);
app.post('/api/auth/refresh', refreshHandler);
app.delete('/api/auth/session', logoutHandler);

// ─── Orders (authenticated) ───────────────────────────────────────────────────

app.use('/api/orders', requireAuth);
app.use('/api/orders/*', requireAuth);
app.post('/api/orders', createOrderHandler);
app.get('/api/orders', listOrdersHandler);
app.get('/api/orders/:id', getOrderHandler);

// ─── Background tasks ─────────────────────────────────────────────────────────

startLocationRefresh();
startMerchantRefresh();

// Periodic cleanup every hour
setInterval(
  () => {
    evictExpiredImageCache();
    // Clear expired rate limit entries
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    }
  },
  60 * 60 * 1000,
);

// ─── Start server ─────────────────────────────────────────────────────────────

const port = parseInt(env.PORT, 10);
logger.info({ port }, 'Loop backend starting');

serve({ fetch: app.fetch, port });
