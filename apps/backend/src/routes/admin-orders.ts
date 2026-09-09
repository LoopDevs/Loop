/**
 * `/api/admin/orders*` route mounts — order triage.
 *
 * Reads and the stuck-order queue ride the support blanket (ADR 037
 * §3): an operator cannot explain a stuck order without first seeing
 * it. The CSV export is admin-tier, because a bulk export of every
 * order is a different risk from one drill.
 *
 * Of the two actions, the redemption re-fetch is support-tier — it
 * re-drives work the customer already paid for and touches no security
 * control, which is exactly the shape ADR 037 puts in the support
 * remit. The re-drive is admin-tier and step-up gated, because it runs
 * a real CTX sweep step that can move the order's state.
 *
 * Mount order: `/orders.csv` and `/orders-activity` are literals that
 * must register before the `/orders/:orderId` param family.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import {
  adminGetOrderHandler,
  adminListOrdersHandler,
  adminOrdersActivityHandler,
  adminOrdersCsvHandler,
} from '../admin/orders.js';
import { adminStuckOrdersHandler } from '../admin/stuck-orders.js';
import { adminOrderRedriveHandler, adminRefetchRedemptionHandler } from '../admin/order-actions.js';

export function mountAdminOrderRoutes(app: Hono): void {
  app.get(
    '/api/admin/orders.csv',
    rateLimit('GET /api/admin/orders.csv', 10, 60_000),
    requireStaff('admin'),
    adminOrdersCsvHandler,
  );
  app.get(
    '/api/admin/orders-activity',
    rateLimit('GET /api/admin/orders-activity', 60, 60_000),
    adminOrdersActivityHandler,
  );
  app.get(
    '/api/admin/stuck-orders',
    rateLimit('GET /api/admin/stuck-orders', 60, 60_000),
    adminStuckOrdersHandler,
  );
  app.get(
    '/api/admin/orders',
    rateLimit('GET /api/admin/orders', 60, 60_000),
    adminListOrdersHandler,
  );
  app.get(
    '/api/admin/orders/:orderId',
    rateLimit('GET /api/admin/orders/:orderId', 60, 60_000),
    adminGetOrderHandler,
  );

  app.post(
    '/api/admin/orders/:orderId/refetch-redemption',
    rateLimit('POST /api/admin/orders/:orderId/refetch-redemption', 10, 60_000),
    requireStaff('support'),
    adminRefetchRedemptionHandler,
  );
  app.post(
    '/api/admin/orders/:orderId/redrive',
    rateLimit('POST /api/admin/orders/:orderId/redrive', 10, 60_000),
    requireStaff('admin'),
    // A5-1: bound to the `'order-redrive'` scope.
    requireAdminStepUp('order-redrive'),
    adminOrderRedriveHandler,
  );
}
