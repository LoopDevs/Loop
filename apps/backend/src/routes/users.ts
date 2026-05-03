/**
 * `/api/users/me/*` route mounts. Pulled out of `app.ts` as the
 * sixth per-domain route module after public / misc / merchants
 * / auth / orders.
 *
 * The user-profile surface bundles three things together for the
 * same reason as `routes/orders.ts`:
 *
 * 1. **Cache-Control: private, no-store** mounts FIRST so the
 *    header lands on every response including the 401 envelope
 *    from missing auth. Without this, a CDN keyed on URL alone
 *    (not Authorization) could cache one user's profile/credits/
 *    cashback-summary response and serve it to another caller.
 * 2. **`requireAuth`** mounts AFTER cache-control so the 401 it
 *    emits still carries `private, no-store`. A2-1002 — same
 *    "401-shape leak via cached 401" defense as `/api/orders`.
 * 3. **Per-route handlers** for ~17 endpoints covering profile,
 *    onboarding writes (home-currency / stellar-address), DSR
 *    self-serve (export + anonymise), credits + payouts +
 *    flywheel + cashback summaries, and the user-facing
 *    payment-method-share self-view.
 *
 * Endpoint groups by area (rate limits in parens):
 *
 * - **Profile** — GET /me (60), POST /home-currency (10),
 *   PUT /stellar-address (10).
 * - **DSR (GDPR / CCPA self-serve)** — GET /dsr/export (5/h —
 *   non-trivial multi-table scan; A2-1906),
 *   POST /dsr/delete (3/h — destructive but must allow legit
 *   retries on transient 5xx; A2-1905). Each request also writes
 *   an info-level log line tagged `area: 'dsr-export'` /
 *   `'dsr-delete'` for the operator audit trail.
 * - **Stellar / payouts** — GET /stellar-trustlines (30),
 *   GET /pending-payouts (60), GET /pending-payouts/summary
 *   (60), GET /pending-payouts/:id (120 — drill-down with 404-
 *   not-403 on cross-user so payout ids aren't enumerable),
 *   GET /orders/:orderId/payout (120 — per-order settlement
 *   card mirror of admin endpoint).
 * - **Cashback ledger** — GET /cashback-history (60),
 *   GET /cashback-history.csv (6 — unbounded CSV; tighter
 *   limit), GET /credits (60), GET /cashback-summary (60),
 *   GET /cashback-by-merchant (60), GET /cashback-monthly (60).
 * - **Orders + flywheel** — GET /orders/summary (60 —
 *   five-number summary; companion to /cashback-summary),
 *   GET /flywheel-stats (60 — recycled-vs-total chip),
 *   GET /payment-method-share (60 — user's own rail mix; #643
 *   self-view of the admin /admin/orders/payment-method-share).
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import {
  dsrDeleteHandler,
  dsrExportHandler,
  getCashbackHistoryHandler,
  getCashbackHistoryCsvHandler,
  getCashbackSummaryHandler,
  getMeHandler,
  getUserCreditsHandler,
  getUserPayoutByOrderHandler,
  getUserPendingPayoutDetailHandler,
  getUserPendingPayoutsHandler,
  getUserPendingPayoutsSummaryHandler,
  setHomeCurrencyHandler,
  setStellarAddressHandler,
} from '../users/handler.js';
import { getUserStellarTrustlinesHandler } from '../users/stellar-trustlines.js';
import { getCashbackByMerchantHandler } from '../users/cashback-by-merchant.js';
import { getCashbackMonthlyHandler } from '../users/cashback-monthly.js';
import { getUserOrdersSummaryHandler } from '../users/orders-summary.js';
import { getUserFlywheelStatsHandler } from '../users/flywheel-stats.js';
import { getUserPaymentMethodShareHandler } from '../users/payment-method-share.js';

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
  app.put(
    '/api/users/me/stellar-address',
    rateLimit('PUT /api/users/me/stellar-address', 10, 60_000),
    setStellarAddressHandler,
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

  // ── Stellar / payouts ───────────────────────────────────────
  app.get(
    '/api/users/me/stellar-trustlines',
    rateLimit('GET /api/users/me/stellar-trustlines', 30, 60_000),
    getUserStellarTrustlinesHandler,
  );
  app.get(
    '/api/users/me/pending-payouts',
    rateLimit('GET /api/users/me/pending-payouts', 60, 60_000),
    getUserPendingPayoutsHandler,
  );
  app.get(
    '/api/users/me/pending-payouts/summary',
    rateLimit('GET /api/users/me/pending-payouts/summary', 60, 60_000),
    getUserPendingPayoutsSummaryHandler,
  );
  // Cross-user access returns 404 (not 403) so payout ids aren't
  // enumerable.
  app.get(
    '/api/users/me/pending-payouts/:id',
    rateLimit('GET /api/users/me/pending-payouts/:id', 120, 60_000),
    getUserPendingPayoutDetailHandler,
  );
  app.get(
    '/api/users/me/orders/:orderId/payout',
    rateLimit('GET /api/users/me/orders/:orderId/payout', 120, 60_000),
    getUserPayoutByOrderHandler,
  );

  // ── Cashback ledger ─────────────────────────────────────────
  app.get(
    '/api/users/me/cashback-history',
    rateLimit('GET /api/users/me/cashback-history', 60, 60_000),
    getCashbackHistoryHandler,
  );
  // Tighter limit: query is unbounded in size.
  app.get(
    '/api/users/me/cashback-history.csv',
    rateLimit('GET /api/users/me/cashback-history.csv', 6, 60_000),
    getCashbackHistoryCsvHandler,
  );
  app.get(
    '/api/users/me/credits',
    rateLimit('GET /api/users/me/credits', 60, 60_000),
    getUserCreditsHandler,
  );
  app.get(
    '/api/users/me/cashback-summary',
    rateLimit('GET /api/users/me/cashback-summary', 60, 60_000),
    getCashbackSummaryHandler,
  );
  app.get(
    '/api/users/me/cashback-by-merchant',
    rateLimit('GET /api/users/me/cashback-by-merchant', 60, 60_000),
    getCashbackByMerchantHandler,
  );
  app.get(
    '/api/users/me/cashback-monthly',
    rateLimit('GET /api/users/me/cashback-monthly', 60, 60_000),
    getCashbackMonthlyHandler,
  );

  // ── Orders + flywheel ───────────────────────────────────────
  app.get(
    '/api/users/me/orders/summary',
    rateLimit('GET /api/users/me/orders/summary', 60, 60_000),
    getUserOrdersSummaryHandler,
  );
  app.get(
    '/api/users/me/flywheel-stats',
    rateLimit('GET /api/users/me/flywheel-stats', 60, 60_000),
    getUserFlywheelStatsHandler,
  );
  // #643 — user-side mirror of /api/admin/orders/payment-method-share.
  app.get(
    '/api/users/me/payment-method-share',
    rateLimit('GET /api/users/me/payment-method-share', 60, 60_000),
    getUserPaymentMethodShareHandler,
  );
}
