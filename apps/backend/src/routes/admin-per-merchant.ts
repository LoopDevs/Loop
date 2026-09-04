/**
 * `/api/admin/merchants/*` route mounts — per-merchant drill +
 * fleet flywheel-share leaderboard
 * (ADR 011 / 015 / 018 / 022).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Nine routes
 * that back the per-merchant drill cluster + the fleet flywheel-
 * share leaderboard. Mirrors the openapi splits across:
 *
 *   - `./openapi/admin-per-merchant-drill.ts` (#1167) — the six
 *     per-merchant drill scalars + time-series.
 *   - `./openapi/admin-fleet-monthly.ts` (#1165) — fleet flywheel-
 *     share + .csv travel here for the same mount-contiguity reason.
 *
 * Routes:
 *   - GET /api/admin/merchants/flywheel-share              (literal)
 *   - GET /api/admin/merchants/flywheel-share.csv          (literal)
 *   - GET /api/admin/merchants/:merchantId/flywheel-stats
 *   - GET /api/admin/merchants/:merchantId/cashback-summary
 *   - GET /api/admin/merchants/:merchantId/payment-method-share
 *   - GET /api/admin/merchants/:merchantId/cashback-monthly
 *   - GET /api/admin/merchants/:merchantId/flywheel-activity
 *   - GET /api/admin/merchants/:merchantId/flywheel-activity.csv
 *   - GET /api/admin/merchants/:merchantId/top-earners
 *
 * Mount-order discipline preserved verbatim — the literal
 * `/merchants/flywheel-share` + `.csv` paths register BEFORE the
 * `/merchants/:merchantId/*` family, so Hono\'s URL-template tree
 * resolves static > dynamic correctly.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { adminMerchantStatsCsvHandler } from '../admin/merchant-stats-csv.js';
import { adminMerchantCashbackSummaryHandler } from '../admin/merchant-cashback-summary.js';
import { adminMerchantCashbackMonthlyHandler } from '../admin/merchant-cashback-monthly.js';
import { adminMerchantTopEarnersHandler } from '../admin/merchant-top-earners.js';

/**
 * Mounts the per-merchant + fleet flywheel-share routes on the
 * supplied Hono app. Called once from `mountAdminRoutes` after the
 * admin middleware stack is in place.
 */
export function mountAdminPerMerchantRoutes(app: Hono): void {
  // Finance / negotiation CSV — flattened per-merchant stats for
  // the CTX rate-deck spreadsheet. Tier-3 rate limit matches the
  // other admin CSV exports.
  app.get(
    '/api/admin/merchant-stats.csv',
    rateLimit('GET /api/admin/merchant-stats.csv', 10, 60_000),
    requireStaff('admin'),
    adminMerchantStatsCsvHandler,
  );
  // Per-merchant cashback-summary (#625) — per-currency lifetime
  // user_cashback_minor on fulfilled orders. Sibling of the per-user
  // variant; drives the "cashback paid out" card on the merchant
  // drill-down. Registered after the literal `/flywheel-share` +
  // `.csv` paths so Hono resolves static > dynamic.
  app.get(
    '/api/admin/merchants/:merchantId/cashback-summary',
    rateLimit('GET /api/admin/merchants/:merchantId/cashback-summary', 120, 60_000),
    adminMerchantCashbackSummaryHandler,
  );
  // Per-merchant cashback-monthly (#635) — 12-month per-(month,
  // currency) user_cashback_minor emission trend for one merchant.
  // Sibling of /api/admin/cashback-monthly (fleet) and
  // /api/admin/users/:userId/cashback-monthly (#633). Drives the
  // forthcoming `MerchantCashbackMonthlyChart` on the merchant
  // drill alongside the scalar cashback-paid-out card.
  app.get(
    '/api/admin/merchants/:merchantId/cashback-monthly',
    rateLimit('GET /api/admin/merchants/:merchantId/cashback-monthly', 120, 60_000),
    adminMerchantCashbackMonthlyHandler,
  );
  // Per-merchant top-earners leaderboard (#655) — ranked list of
  // users who earned the most cashback at one merchant in the
  // window. Inverse axis of user-cashback-by-merchant (per-user
  // view asks "where did Alice earn?"; this asks "who earns at
  // Amazon?"). Drives a "Top earners" card on the merchant drill
  // so BD/support can target outreach to whales at a specific
  // merchant. Joins against users for email enrichment — admin-
  // gated, so email is fine in the response.
  app.get(
    '/api/admin/merchants/:merchantId/top-earners',
    rateLimit('GET /api/admin/merchants/:merchantId/top-earners', 120, 60_000),
    adminMerchantTopEarnersHandler,
  );
}
