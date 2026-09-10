// `/api/admin/orders*` route mounts — order triage — ADR 037
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
    requireAdminStepUp('order-redrive'),
    adminOrderRedriveHandler,
  );
}
