/**
 * `/api/admin/users*` route mounts — the user-360 surface.
 *
 * Reads ride the namespace's `requireStaff('support')` blanket:
 * ADR 037 §3 makes the read views shared, because support cannot do
 * the find-explain-unstick job without being able to look the customer
 * up. The three writes are admin-tier, and two of them are deliberate
 * exemptions from the step-up gate — see each mount.
 *
 * Mount order is the contract: Hono resolves in registration order, so
 * every literal path (`/search`, `/by-email`) has to register before
 * `/:userId` or the literal gets captured as a uuid param.
 *
 * Called from `mountAdminRoutes` after the namespace middleware stack
 * is in place.
 */
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
  // ─── Literal paths, before the /:userId param ─────────────────────
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

  // ─── Per-user drills ──────────────────────────────────────────────
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

  // ─── Writes ───────────────────────────────────────────────────────
  // B4 incident response. Admin-tier but NOT step-up gated: it moves
  // no value, the user simply signs back in, and step-up friction in
  // the first minute of "their laptop was stolen" is the wrong trade.
  app.post(
    '/api/admin/users/:userId/revoke-sessions',
    rateLimit('POST /api/admin/users/:userId/revoke-sessions', 20, 60_000),
    requireStaff('admin'),
    adminRevokeUserSessionsHandler,
  );
  // A5-3. Admin-tier and NOT step-up gated for the same reason as
  // revoke-sessions — clearing the counter grants no access by itself.
  // Its own per-target velocity cap is what bounds abuse here; see the
  // handler.
  app.post(
    '/api/admin/users/:userId/clear-otp-lockout',
    rateLimit('POST /api/admin/users/:userId/clear-otp-lockout', 20, 60_000),
    requireStaff('admin'),
    adminClearOtpLockoutHandler,
  );
  // ADR 015. Step-up gated: it re-denominates what the customer is
  // quoted and charged.
  app.post(
    '/api/admin/users/:userId/home-currency',
    rateLimit('POST /api/admin/users/:userId/home-currency', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('home-currency'),
    adminHomeCurrencySetHandler,
  );
}
