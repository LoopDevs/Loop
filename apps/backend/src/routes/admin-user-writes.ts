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
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import { adminHomeCurrencySetHandler } from '../admin/home-currency-set.js';
import { adminRevokeUserSessionsHandler } from '../auth/revoke-sessions-handler.js';

export function mountAdminUserWritesRoutes(app: Hono): void {
  app.post(
    '/api/admin/users/:userId/home-currency',
    rateLimit('POST /api/admin/users/:userId/home-currency', 20, 60_000),
    requireStaff('admin'),
    // CF-08: bound to the `'home-currency'` scope.
    requireAdminStepUp('home-currency'),
    adminHomeCurrencySetHandler,
  );

  // B4: admin incident-response lever — revoke all of a user's live
  // refresh tokens (kill a compromised session). Admin-tier; NOT
  // step-up-gated (moves no value, reversible — the user just signs
  // back in), so it's on the step-up exempt list in
  // staff-route-gating.test.ts.
  app.post(
    '/api/admin/users/:userId/revoke-sessions',
    rateLimit('POST /api/admin/users/:userId/revoke-sessions', 20, 60_000),
    requireStaff('admin'),
    adminRevokeUserSessionsHandler,
  );
}
