// /api/merchants/* route mounts — A2-650, A2-1008
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  merchantListHandler,
  merchantAllHandler,
  merchantBySlugHandler,
  merchantCashbackRateHandler,
  merchantDetailHandler,
  merchantsCashbackRatesHandler,
} from '../merchants/handler.js';
import { merchantSearchHandler } from '../merchants/search-handler.js';
import { requireAuth } from '../auth/handler.js';

export function mountMerchantRoutes(app: Hono): void {
  app.get('/api/merchants', rateLimit('GET /api/merchants', 180, 60_000), merchantListHandler);
  app.get(
    '/api/merchants/all',
    rateLimit('GET /api/merchants/all', 60, 60_000),
    merchantAllHandler,
  );
  app.get(
    '/api/merchants/search',
    rateLimit('GET /api/merchants/search', 180, 60_000),
    merchantSearchHandler,
  );
  app.get(
    '/api/merchants/by-slug/:slug',
    rateLimit('GET /api/merchants/by-slug/:slug', 120, 60_000),
    merchantBySlugHandler,
  );
  app.get(
    '/api/merchants/cashback-rates',
    rateLimit('GET /api/merchants/cashback-rates', 120, 60_000),
    merchantsCashbackRatesHandler,
  );
  app.get(
    '/api/merchants/:merchantId/cashback-rate',
    rateLimit('GET /api/merchants/:merchantId/cashback-rate', 120, 60_000),
    merchantCashbackRateHandler,
  );
  app.use('/api/merchants/:id', requireAuth);
  app.get(
    '/api/merchants/:id',
    rateLimit('GET /api/merchants/:id', 120, 60_000),
    merchantDetailHandler,
  );
}
