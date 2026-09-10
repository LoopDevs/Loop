// no auth — ADR 020
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { publicCashbackStatsHandler } from '../public/cashback-stats.js';
import { publicCashbackPreviewHandler } from '../public/cashback-preview.js';
import { publicGeoHandler } from '../public/geo.js';
import { publicMerchantHandler } from '../public/merchant.js';
import { publicRumHandler } from '../public/rum.js';
import { publicTopCashbackMerchantsHandler } from '../public/top-cashback-merchants.js';

export function mountPublicRoutes(app: Hono): void {
  app.get(
    '/api/public/cashback-stats',
    rateLimit('GET /api/public/cashback-stats', 60, 60_000),
    publicCashbackStatsHandler,
  );
  app.get('/api/public/geo', rateLimit('GET /api/public/geo', 60, 60_000), publicGeoHandler);
  app.get(
    '/api/public/top-cashback-merchants',
    rateLimit('GET /api/public/top-cashback-merchants', 60, 60_000),
    publicTopCashbackMerchantsHandler,
  );
  app.get(
    '/api/public/merchants/:id',
    rateLimit('GET /api/public/merchants/:id', 60, 60_000),
    publicMerchantHandler,
  );
  app.get(
    '/api/public/cashback-preview',
    rateLimit('GET /api/public/cashback-preview', 60, 60_000),
    publicCashbackPreviewHandler,
  );
  app.post('/api/public/rum', rateLimit('POST /api/public/rum', 60, 60_000), publicRumHandler);
}
