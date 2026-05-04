/**
 * `/api/admin/merchants/*` route mounts — per-merchant drill +
 * fleet flywheel-share leaderboard
 * (ADR 011 / 013 / 015 / 018 / 022).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Ten routes
 * that back the per-merchant drill cluster + the fleet flywheel-
 * share leaderboard. Mirrors the openapi splits across:
 *
 *   - `./openapi/admin-per-merchant-drill.ts` (#1167) — the six
 *     per-merchant drill scalars + time-series.
 *   - `./openapi/admin-operator-mix.ts` (#1171) — the merchant ×
 *     operator-mix path travels with this slice on the routes side
 *     because it sits in the contiguous per-merchant mount block.
 *   - `./openapi/admin-fleet-monthly.ts` (#1165) — fleet flywheel-
 *     share + .csv travel here for the same mount-contiguity reason.
 *
 * Routes:
 *   - GET /api/admin/merchants/:merchantId/operator-mix
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
import { adminMerchantOperatorMixHandler } from '../admin/merchant-operator-mix.js';
import { adminMerchantStatsCsvHandler } from '../admin/merchant-stats-csv.js';
import { adminMerchantsFlywheelShareHandler } from '../admin/merchants-flywheel-share.js';
import { adminMerchantsFlywheelShareCsvHandler } from '../admin/merchants-flywheel-share-csv.js';
import { adminMerchantFlywheelStatsHandler } from '../admin/merchant-flywheel-stats.js';
import { adminMerchantCashbackSummaryHandler } from '../admin/merchant-cashback-summary.js';
import { adminMerchantPaymentMethodShareHandler } from '../admin/merchant-payment-method-share.js';
import { adminMerchantCashbackMonthlyHandler } from '../admin/merchant-cashback-monthly.js';
import { adminMerchantFlywheelActivityHandler } from '../admin/merchant-flywheel-activity.js';
import { adminMerchantFlywheelActivityCsvHandler } from '../admin/merchant-flywheel-activity-csv.js';
import { adminMerchantTopEarnersHandler } from '../admin/merchant-top-earners.js';

/**
 * Mounts the per-merchant + fleet flywheel-share routes on the
 * supplied Hono app. Called once from `mountAdminRoutes` after the
 * admin middleware stack is in place.
 */
export function mountAdminPerMerchantRoutes(app: Hono): void {
  // Per-merchant × per-operator mix (ADR 013 / 022). The
  // merchant-axis complement to operator-stats: lives under
  // /merchants/:merchantId so an incident triage landing on
  // /admin/merchants/:id can ask "which operator is primarily
  // carrying this merchant right now?". Complements the fleet
  // operator-stats + the per-operator drill quartet.
  app.get(
    '/api/admin/merchants/:merchantId/operator-mix',
    rateLimit('GET /api/admin/merchants/:merchantId/operator-mix', 120, 60_000),
    adminMerchantOperatorMixHandler,
  );
  // Finance / negotiation CSV — flattened per-merchant stats for
  // the CTX rate-deck spreadsheet. Tier-3 rate limit matches the
  // other admin CSV exports.
  app.get(
    '/api/admin/merchant-stats.csv',
    rateLimit('GET /api/admin/merchant-stats.csv', 10, 60_000),
    adminMerchantStatsCsvHandler,
  );
  // Per-merchant flywheel leaderboard — which merchants see the most
  // recycled-cashback traffic. Merchant-axis cousin of /orders/payment-
  // method-share (fleet) + /orders/payment-method-activity (time).
  // Zero-recycle merchants filtered out; sorted by recycled-count desc.
  app.get(
    '/api/admin/merchants/flywheel-share',
    rateLimit('GET /api/admin/merchants/flywheel-share', 60, 60_000),
    adminMerchantsFlywheelShareHandler,
  );
  // Tier-3 CSV snapshot of the merchant flywheel leaderboard —
  // finance / CTX-negotiation export. Same aggregate as the JSON,
  // flattened for spreadsheet consumption. 10/min rate limit matches
  // every other admin CSV.
  app.get(
    '/api/admin/merchants/flywheel-share.csv',
    rateLimit('GET /api/admin/merchants/flywheel-share.csv', 10, 60_000),
    adminMerchantsFlywheelShareCsvHandler,
  );
  // Per-merchant scalar flywheel stats — the single-merchant drill
  // mirror of the fleet leaderboard. Drives a chip on the
  // /admin/merchants/:merchantId page. Registered after the literal
  // `/flywheel-share` + `.csv` paths so Hono's matcher resolves
  // static > dynamic correctly.
  app.get(
    '/api/admin/merchants/:merchantId/flywheel-stats',
    rateLimit('GET /api/admin/merchants/:merchantId/flywheel-stats', 120, 60_000),
    adminMerchantFlywheelStatsHandler,
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
  // Per-merchant payment-method share (#627) — rail mix on one
  // merchant. Sibling of `/api/admin/orders/payment-method-share`,
  // scoped via WHERE merchant_id = :merchantId. Drives a small
  // "rail mix" card on the merchant drill alongside flywheel +
  // cashback-paid. Default ?state=fulfilled, zero-filled across
  // every known payment method for stable layout.
  app.get(
    '/api/admin/merchants/:merchantId/payment-method-share',
    rateLimit('GET /api/admin/merchants/:merchantId/payment-method-share', 120, 60_000),
    adminMerchantPaymentMethodShareHandler,
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
  // Per-merchant flywheel-activity time-series (#641) — daily
  // recycled-vs-total fulfilled-order counts. Time-axis companion
  // to the scalar /flywheel-stats endpoint from #623; drives the
  // forthcoming sparkline on /admin/merchants/:merchantId so ops
  // can see whether LOOP-asset adoption at a merchant is rising
  // or plateaued over time.
  app.get(
    '/api/admin/merchants/:merchantId/flywheel-activity',
    rateLimit('GET /api/admin/merchants/:merchantId/flywheel-activity', 120, 60_000),
    adminMerchantFlywheelActivityHandler,
  );
  // Tier-3 CSV export of the same per-merchant flywheel-activity
  // aggregate (#645). Finance / BD runs this when prepping a
  // commercial conversation with a merchant or negotiating
  // cashback-rate changes against observed recycling behaviour.
  // Rate-limited 10/min per ADR 018.
  app.get(
    '/api/admin/merchants/:merchantId/flywheel-activity.csv',
    rateLimit('GET /api/admin/merchants/:merchantId/flywheel-activity.csv', 10, 60_000),
    adminMerchantFlywheelActivityCsvHandler,
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
