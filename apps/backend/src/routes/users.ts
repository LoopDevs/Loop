import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import {
  dsrDeleteHandler,
  dsrExportHandler,
  getMeHandler,
  setCashbackDestinationHandler,
  setHomeCurrencyHandler,
} from '../users/handler.js';
import { getUserOrdersSummaryHandler } from '../users/orders-summary.js';
import {
  addFavoriteHandler,
  listFavoritesHandler,
  removeFavoriteHandler,
} from '../users/favorites-handler.js';
import { listRecentlyPurchasedHandler } from '../users/recently-purchased-handler.js';
import {
  depositSavingsHandler,
  getAccountHandler,
  linkWalletHandler,
  unlinkWalletHandler,
  updateWalletHandler,
  withdrawSavingsHandler,
} from '../users/account-handler.js';

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

  app.get(
    '/api/users/me/account',
    rateLimit('GET /api/users/me/account', 60, 60_000),
    getAccountHandler,
  );
  app.post(
    '/api/users/me/wallets',
    rateLimit('POST /api/users/me/wallets', 10, 60_000),
    linkWalletHandler,
  );
  app.put(
    '/api/users/me/wallets/:walletId',
    rateLimit('PUT /api/users/me/wallets/:walletId', 10, 60_000),
    updateWalletHandler,
  );
  app.delete(
    '/api/users/me/wallets/:walletId',
    rateLimit('DELETE /api/users/me/wallets/:walletId', 10, 60_000),
    unlinkWalletHandler,
  );
  app.post(
    '/api/users/me/savings/deposits',
    rateLimit('POST /api/users/me/savings/deposits', 10, 60_000),
    depositSavingsHandler,
  );
  app.post(
    '/api/users/me/savings/withdrawals',
    rateLimit('POST /api/users/me/savings/withdrawals', 10, 60_000),
    withdrawSavingsHandler,
  );
  app.post(
    '/api/users/me/cashback-destination',
    rateLimit('POST /api/users/me/cashback-destination', 10, 60_000),
    setCashbackDestinationHandler,
  );
}
