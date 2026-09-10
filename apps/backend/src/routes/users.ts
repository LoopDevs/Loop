import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import {
  dsrDeleteHandler,
  dsrExportHandler,
  getMeHandler,
  setHomeCurrencyHandler,
} from '../users/handler.js';
import { getUserOrdersSummaryHandler } from '../users/orders-summary.js';
import {
  addFavoriteHandler,
  listFavoritesHandler,
  removeFavoriteHandler,
} from '../users/favorites-handler.js';
import { listRecentlyPurchasedHandler } from '../users/recently-purchased-handler.js';

export function mountUserRoutes(app: Hono): void {
  // Cache-Control mount FIRST — must precede `requireAuth` so the
  // header lands on the 401 envelope too (A2-1002).
  app.use('/api/users/me', privateNoStoreResponse);
  app.use('/api/users/me/*', privateNoStoreResponse);

  app.use('/api/users/me', requireAuth);
  app.use('/api/users/me/*', requireAuth);

  app.get('/api/users/me', rateLimit('GET /api/users/me', 60, 60_000), getMeHandler);
  app.post(
    '/api/users/me/home-currency',
    rateLimit('POST /api/users/me/home-currency', 10, 60_000),
    setHomeCurrencyHandler,
  );

  // low limit: destructive, but leaves room for retries after
  // transient 5xx (A2-1905 / A2-1906)
  app.get(
    '/api/users/me/dsr/export',
    rateLimit('GET /api/users/me/dsr/export', 5, 60 * 60_000),
    dsrExportHandler,
  );
  app.post(
    '/api/users/me/dsr/delete',
    rateLimit('POST /api/users/me/dsr/delete', 3, 60 * 60_000),
    dsrDeleteHandler,
  );

  app.get(
    '/api/users/me/orders/summary',
    rateLimit('GET /api/users/me/orders/summary', 60, 60_000),
    getUserOrdersSummaryHandler,
  );

  app.get(
    '/api/users/me/favorites',
    rateLimit('GET /api/users/me/favorites', 60, 60_000),
    listFavoritesHandler,
  );
  app.post(
    '/api/users/me/favorites',
    rateLimit('POST /api/users/me/favorites', 20, 60_000),
    addFavoriteHandler,
  );
  app.delete(
    '/api/users/me/favorites/:merchantId',
    rateLimit('DELETE /api/users/me/favorites/:merchantId', 20, 60_000),
    removeFavoriteHandler,
  );

  app.get(
    '/api/users/me/recently-purchased',
    rateLimit('GET /api/users/me/recently-purchased', 60, 60_000),
    listRecentlyPurchasedHandler,
  );
}
