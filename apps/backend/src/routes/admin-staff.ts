/**
 * `/api/admin/staff*` route mounts (ADR 037 §1 — role management).
 *
 * Admin-tier only: the grant/revoke writes are the first self-serve
 * alternative to direct-SQL escalation, so they carry the ADR 028
 * step-up gate ON TOP of the admin tier — a captured bearer alone
 * must not be able to mint itself a colleague — plus the full
 * ADR 017 envelope (idempotency, reason, Discord audit). The list
 * is admin-tier too: who holds power is itself sensitive, and
 * support has no action to take on it.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the namespace middleware stack
 * (cache-control / requireAuth / requireStaff('support') blanket /
 * audit middleware) is in place; that's the parent factory's
 * responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import {
  adminGrantStaffRoleHandler,
  adminListStaffHandler,
  adminRevokeStaffRoleHandler,
} from '../admin/staff-roles.js';

/**
 * Mounts the staff role-management routes on the supplied Hono app.
 * Called once from `mountAdminRoutes` after the admin middleware
 * stack is in place.
 */
export function mountAdminStaffRoutes(app: Hono): void {
  app.get(
    '/api/admin/staff',
    rateLimit('GET /api/admin/staff', 60, 60_000),
    requireStaff('admin'),
    adminListStaffHandler,
  );
  // Low rate limit on the writes — granting roles is a rare,
  // deliberate ops action, and 10/min still leaves headroom for a
  // bulk onboarding session.
  app.put(
    '/api/admin/staff/:userId/role',
    rateLimit('PUT /api/admin/staff/:userId/role', 10, 60_000),
    requireStaff('admin'),
    // CF-08: bound to the `'staff-role-grant'` scope.
    requireAdminStepUp('staff-role-grant'),
    adminGrantStaffRoleHandler,
  );
  app.delete(
    '/api/admin/staff/:userId/role',
    rateLimit('DELETE /api/admin/staff/:userId/role', 10, 60_000),
    requireStaff('admin'),
    // CF-08: bound to the `'staff-role-revoke'` scope.
    requireAdminStepUp('staff-role-revoke'),
    adminRevokeStaffRoleHandler,
  );
}
