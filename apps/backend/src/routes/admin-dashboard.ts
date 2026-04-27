/**
 * `/api/admin/*` dashboard-cluster route mounts
 * (ADR 009 / 011 / 013 / 015 / 016 / 018).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Seven routes
 * that read together as the operational + flywheel signals on the
 * `/admin` landing page — same routes the openapi spec splits into
 * `./openapi/admin-dashboard-cluster.ts` (#1174), plus the
 * `cashback-realization/daily.csv` Tier-3 companion which travels
 * alongside its JSON sibling on the routes side rather than inside
 * the all-CSV cluster (mirror of the route-mount contiguity).
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminStuckOrdersHandler } from '../admin/stuck-orders.js';
import { adminStuckPayoutsHandler } from '../admin/stuck-payouts.js';
import { adminCashbackActivityHandler } from '../admin/cashback-activity.js';
import { adminCashbackActivityCsvHandler } from '../admin/cashback-activity-csv.js';
import { adminCashbackRealizationHandler } from '../admin/cashback-realization.js';
import { adminCashbackRealizationDailyHandler } from '../admin/cashback-realization-daily.js';
import { adminCashbackRealizationDailyCsvHandler } from '../admin/cashback-realization-daily-csv.js';

/**
 * Mounts the dashboard-cluster routes on the supplied Hono app.
 * Called once from `mountAdminRoutes` after the admin middleware
 * stack is in place.
 */
export function mountAdminDashboardRoutes(app: Hono): void {
  // Stuck-orders triage. Dashboard pings this every 30-60s — higher
  // rate limit because the admin UI polls it on a loop to surface
  // an SLO red-flag card.
  app.get('/api/admin/stuck-orders', rateLimit(120, 60_000), adminStuckOrdersHandler);
  // Stuck-payouts triage — pending_payouts rows in pending/submitted
  // past the SLO threshold (ADR 015/016). Same 120/min polling budget
  // as stuck-orders since both feed the same dashboard card and often
  // refetch together.
  app.get('/api/admin/stuck-payouts', rateLimit(120, 60_000), adminStuckPayoutsHandler);
  // Daily cashback-accrual time-series for the dashboard sparkline.
  // Cheap read — single generate_series + LEFT JOIN, bounded at 180
  // days so the payload can't explode.
  app.get('/api/admin/cashback-activity', rateLimit(60, 60_000), adminCashbackActivityHandler);
  // Cashback realization rate — per-currency earned vs spent vs
  // outstanding, plus a fleet-wide aggregate row. The flywheel-health
  // KPI: high realization = users recycling cashback into new orders
  // rather than hoarding or withdrawing (ADR 009/015).
  app.get(
    '/api/admin/cashback-realization',
    rateLimit(60, 60_000),
    adminCashbackRealizationHandler,
  );
  // Daily realization time-series — per-(day, currency) earned +
  // spent + recycledBps. Drift-over-time companion to the single-point
  // realization surface above; powers the sparkline on /admin landing.
  app.get(
    '/api/admin/cashback-realization/daily',
    rateLimit(60, 60_000),
    adminCashbackRealizationDailyHandler,
  );
  // Finance-ready CSV of the daily realization trend. Tier-3 10/min
  // rate limit + `private, no-store` + attachment disposition — same
  // discipline as the other month-end exports.
  app.get(
    '/api/admin/cashback-realization/daily.csv',
    rateLimit(10, 60_000),
    adminCashbackRealizationDailyCsvHandler,
  );
  // Finance-ready CSV: daily × per-currency cashback accrual. Same
  // aggregate as the JSON surface, flattened for spreadsheet use.
  // Tier-3 rate limit — month-end finance use, not polling.
  app.get(
    '/api/admin/cashback-activity.csv',
    rateLimit(10, 60_000),
    adminCashbackActivityCsvHandler,
  );
}
