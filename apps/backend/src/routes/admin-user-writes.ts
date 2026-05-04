/**
 * `/api/admin/users/:userId/home-currency` route mount.
 *
 * Sibling of `./admin-credit-writes.ts` for admin-mediated user-
 * property writes that aren't credit/refund/withdrawal — currently
 * just the home-currency flip (ADR 015 deferred § "self-serve
 * home-currency change — currently support-mediated").
 *
 * Same middleware envelope as the credit writes:
 *   - mounted AFTER the parent admin middleware stack
 *     (cache-control / requireAuth / requireAdmin / audit) is in
 *     place — that's `mountAdminRoutes`' responsibility.
 *   - rate-limited at 20/min per IP, matching the other admin
 *     user-scoped POSTs.
 *   - gated behind `requireAdminStepUp()` per ADR 028 — a captured
 *     bearer must NOT be able to retarget which LOOP-asset a user's
 *     future cashback is paid in.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import { adminHomeCurrencySetHandler } from '../admin/home-currency-set.js';

export function mountAdminUserWritesRoutes(app: Hono): void {
  app.post(
    '/api/admin/users/:userId/home-currency',
    rateLimit('POST /api/admin/users/:userId/home-currency', 20, 60_000),
    requireAdminStepUp(),
    adminHomeCurrencySetHandler,
  );
}
