// /api/admin/staff* route mounts — ADR 037 §1, ADR 028, ADR 017
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import {
  adminGrantStaffRoleHandler,
  adminListStaffHandler,
  adminRevokeStaffRoleHandler,
} from '../admin/staff-roles.js';

export function mountAdminStaffRoutes(app: Hono): void {
  app.get(
    '/api/admin/staff',
    rateLimit('GET /api/admin/staff', 60, 60_000),
    requireStaff('admin'),
    adminListStaffHandler,
  );
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
