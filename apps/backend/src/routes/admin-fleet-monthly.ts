/**
 * `/api/admin/*` fleet-monthly + finance-CSV route mounts
 * (ADR 009 / 011 / 013 / 015 / 016 / 018).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Seven routes
 * that finance / ops use at month-end to reconcile the
 * minted-vs-settled liability story:
 *
 *   - GET /api/admin/cashback-monthly                   (12mo bar)
 *   - GET /api/admin/payouts-monthly                    (12mo bar)
 *   - GET /api/admin/payouts-activity                   (sparkline)
 *   - GET /api/admin/payouts-activity.csv               (Tier-3)
 *   - GET /api/admin/supplier-spend/activity.csv        (Tier-3)
 *   - GET /api/admin/operators-snapshot.csv             (Tier-3)
 *   - GET /api/admin/treasury/credit-flow.csv           (Tier-3)
 *
 * Mirrors the openapi/admin-fleet-monthly.ts split (#1165) for the
 * three JSON aggregates; the four Tier-3 CSV companions live next
 * to their JSON siblings on the routes side because the contiguous
 * mount block keeps the literal-suffix ordering simpler than
 * splitting between two files.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminCashbackMonthlyHandler } from '../admin/cashback-monthly.js';
import { adminPayoutsMonthlyHandler } from '../admin/payouts-monthly.js';
import { adminPayoutsActivityHandler } from '../admin/payouts-activity.js';
import { adminPayoutsActivityCsvHandler } from '../admin/payouts-activity-csv.js';
import { adminSupplierSpendActivityCsvHandler } from '../admin/supplier-spend-activity-csv.js';
import { adminOperatorsSnapshotCsvHandler } from '../admin/operators-snapshot-csv.js';
import { adminTreasuryCreditFlowCsvHandler } from '../admin/treasury-credit-flow-csv.js';

/**
 * Mounts the fleet-monthly + finance-CSV routes on the supplied
 * Hono app. Called once from `mountAdminRoutes` after the admin
 * middleware stack is in place.
 */
export function mountAdminFleetMonthlyRoutes(app: Hono): void {
  // Fleet-wide monthly-cashback bar chart — per-(month, currency)
  // emission totals over a fixed 12-month window. Mirrors the user-
  // facing /api/users/me/cashback-monthly shape so the same chart
  // component can render either. Single aggregate query.
  app.get(
    '/api/admin/cashback-monthly',
    rateLimit('GET /api/admin/cashback-monthly', 60, 60_000),
    adminCashbackMonthlyHandler,
  );
  // Monthly confirmed-payout totals (#631) — settlement-side
  // counterpart to cashback-monthly. Cashback-monthly measures
  // liability creation (credits minted); this measures liability
  // settlement (confirmed on-chain payouts). Pairing the two
  // answers "is outstanding liability growing or shrinking this
  // month?". Same 12-month window + oldest-first ordering.
  app.get(
    '/api/admin/payouts-monthly',
    rateLimit('GET /api/admin/payouts-monthly', 60, 60_000),
    adminPayoutsMonthlyHandler,
  );
  // Daily payouts-activity (#637) — settlement-side sparkline
  // counterpart to cashback-activity. Same ?days window (default
  // 30, max 180), LEFT-JOIN generate_series so zero-days render
  // as empty byAsset[]. Drives the payout-trend sparkline on
  // /admin/treasury.
  app.get(
    '/api/admin/payouts-activity',
    rateLimit('GET /api/admin/payouts-activity', 60, 60_000),
    adminPayoutsActivityHandler,
  );
  // Tier-3 CSV export of the same aggregate (#638) — finance runs
  // this alongside /api/admin/cashback-activity.csv at month-end
  // to reconcile liability creation vs. settlement. Rate-limited
  // 10/min per ADR 018.
  app.get(
    '/api/admin/payouts-activity.csv',
    rateLimit('GET /api/admin/payouts-activity.csv', 10, 60_000),
    adminPayoutsActivityCsvHandler,
  );
  // Tier-3 CSV export of supplier-spend activity (ADR 013/015/018) —
  // finance runs this at month-end to reconcile CTX's invoice: the
  // wholesale_minor column per (day, currency) should tie to CTX's
  // line items. Pairs with cashback-activity.csv (what we minted)
  // and payouts-activity.csv (what we settled).
  app.get(
    '/api/admin/supplier-spend/activity.csv',
    rateLimit('GET /api/admin/supplier-spend/activity.csv', 10, 60_000),
    adminSupplierSpendActivityCsvHandler,
  );
  // Tier-3 CSV of the fleet operator snapshot (ADR 013 / 018 / 022)
  // — joins operator-stats + operator-latency into one row per
  // operator. Handed to CTX relationship owners for quarterly
  // review meetings (SLA + volume + success rate on one sheet).
  app.get(
    '/api/admin/operators-snapshot.csv',
    rateLimit('GET /api/admin/operators-snapshot.csv', 10, 60_000),
    adminOperatorsSnapshotCsvHandler,
  );
  // Tier-3 CSV of the credit-flow time series (ADR 009 / 015 / 018).
  // Completes the finance-CSV quartet: cashback-activity (minted) +
  // payouts-activity (settled on-chain) + supplier-spend/activity
  // (paid to CTX) + this (net ledger movement).
  app.get(
    '/api/admin/treasury/credit-flow.csv',
    rateLimit('GET /api/admin/treasury/credit-flow.csv', 10, 60_000),
    adminTreasuryCreditFlowCsvHandler,
  );
}
