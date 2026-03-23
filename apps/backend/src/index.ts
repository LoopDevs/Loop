import { serve } from '@hono/node-server';
import { Hono } from 'hono';
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

app.get('/api/image', imageProxyHandler);

// ─── Merchants ────────────────────────────────────────────────────────────────

app.get('/api/merchants', merchantListHandler);
app.get('/api/merchants/by-slug/:slug', merchantBySlugHandler); // must be before /:id
app.get('/api/merchants/:id', merchantDetailHandler);

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/request-otp', requestOtpHandler);
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
  },
  60 * 60 * 1000,
);

// ─── Start server ─────────────────────────────────────────────────────────────

const port = parseInt(env.PORT, 10);
logger.info({ port }, 'Loop backend starting');

serve({ fetch: app.fetch, port });
