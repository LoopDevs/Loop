// /api/admin/users* route mounts — ADR 037 §3, ADR 015, A5-3
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import { adminUserSearchHandler } from '../admin/user-search.js';
import { adminListUsersHandler } from '../admin/users-list.js';
import { adminGetUserHandler, adminUserByEmailHandler } from '../admin/user-detail.js';
import { adminUserAuthStateHandler } from '../admin/user-auth-state.js';
import { adminClearOtpLockoutHandler } from '../admin/clear-otp-lockout.js';
import { adminHomeCurrencySetHandler } from '../admin/home-currency-set.js';
import { adminRevokeUserSessionsHandler } from '../auth/revoke-sessions-handler.js';

export function mountAdminUserRoutes(app: Hono): void {
  // Hono resolves in registration order; literals must precede /:userId
  app.get(
    '/api/admin/users/search',
    rateLimit('GET /api/admin/users/search', 60, 60_000),
    adminUserSearchHandler,
  );
  app.get(
    '/api/admin/users/by-email',
    rateLimit('GET /api/admin/users/by-email', 60, 60_000),
    adminUserByEmailHandler,
  );
  app.get('/api/admin/users', rateLimit('GET /api/admin/users', 60, 60_000), adminListUsersHandler);

  app.get(
    '/api/admin/users/:userId',
    rateLimit('GET /api/admin/users/:userId', 60, 60_000),
    adminGetUserHandler,
  );
  app.get(
    '/api/admin/users/:userId/auth-state',
    rateLimit('GET /api/admin/users/:userId/auth-state', 60, 60_000),
    adminUserAuthStateHandler,
  );

  // B4 incident response; no step-up to avoid friction during immediate recovery
  app.post(
    '/api/admin/users/:userId/revoke-sessions',
    rateLimit('POST /api/admin/users/:userId/revoke-sessions', 20, 60_000),
    requireStaff('admin'),
    adminRevokeUserSessionsHandler,
  );
  // A5-3; no step-up as clearing counter grants no access; handler enforces velocity cap
  app.post(
    '/api/admin/users/:userId/clear-otp-lockout',
    rateLimit('POST /api/admin/users/:userId/clear-otp-lockout', 20, 60_000),
    requireStaff('admin'),
    adminClearOtpLockoutHandler,
  );
  // ADR 015; step-up gated because it re-denominates customer charges
  app.post(
    '/api/admin/users/:userId/home-currency',
    rateLimit('POST /api/admin/users/:userId/home-currency', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('home-currency'),
    adminHomeCurrencySetHandler,
  );
}
