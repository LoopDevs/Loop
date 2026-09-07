/**
 * `/api/users/me/*` route mounts.
 *
 * The user-profile surface bundles three things together for the
 * same reason as `routes/orders.ts`:
 *
 * 1. **Cache-Control: private, no-store** mounts FIRST so the
 *    header lands on every response including the 401 envelope
 *    from missing auth. Without this, a CDN keyed on URL alone
 *    (not Authorization) could cache one user's profile response
 *    and serve it to another caller.
 * 2. **`requireAuth`** mounts AFTER cache-control so the 401 it
 *    emits still carries `private, no-store`. A2-1002 — same
 *    "401-shape leak via cached 401" defense as `/api/orders`.
 * 3. **Per-route handlers** covering profile, the onboarding
 *    home-currency write, DSR self-serve (export + anonymise),
 *    favourites, recently-purchased, and the orders summary.
 */
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

/** Mounts all `/api/users/me/*` routes on the supplied Hono app. */
export function mountUserRoutes(app: Hono): void {
  // Cache-Control mount FIRST — must precede `requireAuth` so the
  // header lands on the 401 envelope too (A2-1002).
  app.use('/api/users/me', privateNoStoreResponse);
  app.use('/api/users/me/*', privateNoStoreResponse);

  app.use('/api/users/me', requireAuth);
  app.use('/api/users/me/*', requireAuth);

  // ── Profile ─────────────────────────────────────────────────
  app.get('/api/users/me', rateLimit('GET /api/users/me', 60, 60_000), getMeHandler);
  app.post(
    '/api/users/me/home-currency',
    rateLimit('POST /api/users/me/home-currency', 10, 60_000),
    setHomeCurrencyHandler,
  );

  // ── DSR self-serve (GDPR / CCPA) ────────────────────────────
  // Each handler writes an info-level audit log line. 5/h export,
  // 3/h delete — destructive but must tolerate legit retries on
  // transient 5xx without locking the user out of their own
  // deletion (A2-1905 / A2-1906).
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

  // ── Orders summary ──────────────────────────────────────────
  app.get(
    '/api/users/me/orders/summary',
    rateLimit('GET /api/users/me/orders/summary', 60, 60_000),
    getUserOrdersSummaryHandler,
  );

  // ── Favourites ──────────────────────────────────────────────
  // Per-user pin list of merchants for the home grid. Read is
  // higher-volume (every home render); writes are infrequent. 50
  // is the per-user cap (favorites-handler.ts MAX_FAVORITES_PER_USER).
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

  // ── Recently purchased ──────────────────────────────────────
  // Sister surface to favourites, derived from the orders history.
  app.get(
    '/api/users/me/recently-purchased',
    rateLimit('GET /api/users/me/recently-purchased', 60, 60_000),
    listRecentlyPurchasedHandler,
  );
}
