/**
 * `/api/admin/ctx-commission` route mount (ADR 051 / 052).
 *
 * Historical name: this file once mounted the supplier-spend
 * cluster; those routes were retired with the money-in rails
 * (ADR 052 — CTX accrues the commission, Loop reads it back).
 * The CTX-commission proxy is the surviving — and now primary —
 * admin money surface here.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that's the parent factory's responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminCtxCommissionHandler } from '../admin/ctx-commission.js';

/**
 * Mounts the supplier-spend routes on the supplied Hono app. Called
 * once from `mountAdminRoutes` after the admin middleware stack is
 * in place.
 */
export function mountAdminSupplierSpendRoutes(app: Hono): void {
  // CTX operator-commission proxy (ctx-interop): CTX's record of the
  // commission it owes Loop for attributed orders + recent
  // settlements, reconciled against the orders' logged
  // expected_commission_minor. Read-only, and upstream-fetching —
  // 30/min keeps a misbehaving dashboard from hammering CTX through
  // us.
  app.get(
    '/api/admin/ctx-commission',
    rateLimit('GET /api/admin/ctx-commission', 30, 60_000),
    adminCtxCommissionHandler,
  );
}
