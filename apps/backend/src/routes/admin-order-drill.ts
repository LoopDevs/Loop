/**
 * `/api/admin/orders*` route mounts — the order-drill cluster
 * (ADR 010 / 011 / 015 / 019).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Six routes
 * that back the order-drill surfaces — same routes the openapi
 * spec splits into `./openapi/admin-order-cluster.ts` (#1177), plus
 * `POST /orders/:orderId/redrive` (A5-1, its own openapi slice
 * `./openapi/admin-order-redrive.ts`) and `POST /orders/:orderId/refund`
 * (A5-4, its own openapi slice `./openapi/admin-order-refund.ts`).
 *
 * Mount-order discipline preserved verbatim — the literal-suffix
 * routes (`/orders/activity`, `/orders/payment-method-share`,
 * `/orders/payment-method-activity`) MUST register BEFORE the
 * param-only `/orders/:orderId`, otherwise Hono\'s URL-template
 * tree captures the literal as a `:orderId` value. `/orders/:orderId/redrive`
 * and `/orders/:orderId/refund` are longer, distinctly-shaped templates
 * (3 segments vs 2) so neither collides with `/orders/:orderId`
 * regardless of registration order, but both are mounted after it for
 * readability (GETs before the writes).
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { adminGetOrderHandler } from '../admin/orders.js';
import { adminOrdersActivityHandler } from '../admin/orders-activity.js';
import { adminOrdersCsvHandler } from '../admin/orders-csv.js';

/**
 * Mounts the order-drill `/api/admin/orders/*` routes on the
 * supplied Hono app. Called once from `mountAdminRoutes` after
 * the admin middleware stack is in place.
 */
export function mountAdminOrderDrillRoutes(app: Hono): void {
  // 7-day (or N-day, clamped 1-90) order-activity sparkline. Drives the
  // admin dashboard's "created vs fulfilled per day" chart. Single
  // generate_series + LEFT JOIN; every day in the window appears with
  // zero-filled counts when no orders crossed. Registered before
  // `/:orderId` so the literal `/activity` matches first.
  app.get(
    '/api/admin/orders/activity',
    rateLimit('GET /api/admin/orders/activity', 60, 60_000),
    adminOrdersActivityHandler,
  );
  // Single-order drill-down (ADR 011 / 015). Permalink for an ops
  // ticket or incident note. Higher rate-limit than the list because
  // the admin UI re-fetches detail on every navigation.
  app.get(
    '/api/admin/orders/:orderId',
    rateLimit('GET /api/admin/orders/:orderId', 120, 60_000),
    adminGetOrderHandler,
  );
  // Finance-ready CSV export of Loop-native orders. Same rate-limit
  // cadence as other Tier-3 exports — ops runs it manually at month-end,
  // not on-click from the UI.
  app.get(
    '/api/admin/orders.csv',
    rateLimit('GET /api/admin/orders.csv', 10, 60_000),
    requireStaff('admin'),
    adminOrdersCsvHandler,
  );
}
