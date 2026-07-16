/**
 * Admin-tier user-scoped write mounts: `/api/admin/users/:userId/home-currency`,
 * `/revoke-sessions` (B4), `/clear-otp-lockout` (A5-3), plus the
 * sibling `/api/admin/deposits/:paymentId/refund` (A6).
 *
 * Sibling of `./admin-credit-writes.ts` for admin-mediated user-
 * property writes that aren't credit/refund/withdrawal — the
 * home-currency flip (ADR 015 deferred § "self-serve home-currency
 * change — currently support-mediated"), incident-response session
 * revocation (B4), and the B5 OTP-lockout clear (A5-3).
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
import { adminDepositRefundHandler } from '../admin/deposit-refund-handler.js';
import { adminClearOtpLockoutHandler } from '../admin/clear-otp-lockout.js';
import {
  adminPlaceAccountHoldHandler,
  adminReleaseAccountHoldHandler,
  adminListUserAccountHoldsHandler,
  adminListActiveAccountHoldsHandler,
} from '../admin/account-holds.js';

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

  // A5-3: incident-response lever — clear the B5 verify-otp lockout
  // counter for a user (the common support case: legit user
  // fat-fingered the code, is locked out, needs to be let back in).
  // Admin-tier; NOT step-up-gated (moves no value, and clearing the
  // counter doesn't itself grant access — see admin/clear-otp-lockout.ts
  // for the full tier reasoning). Requires `reason` + fires the ADR
  // 017-lite Discord audit (unlike revoke-sessions, which predates
  // that convention).
  app.post(
    '/api/admin/users/:userId/clear-otp-lockout',
    rateLimit('POST /api/admin/users/:userId/clear-otp-lockout', 20, 60_000),
    requireStaff('admin'),
    adminClearOtpLockoutHandler,
  );

  // A6: refund an abandoned late deposit to its on-chain sender.
  // Admin-tier + step-up (`'deposit-refund'`) — it submits an outbound
  // Stellar payment from the operator account.
  app.post(
    '/api/admin/deposits/:paymentId/refund',
    rateLimit('POST /api/admin/deposits/:paymentId/refund', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('deposit-refund'),
    adminDepositRefundHandler,
  );

  // NS-08: per-account freeze / AML-hold. Placing a hold refuses every
  // debit path for one account; releasing it re-opens money movement.
  // Both are admin-tier + step-up (separate scope per direction so a
  // freeze token can't be replayed to unfreeze) + idempotent + reasoned
  // + Discord-audited.
  //
  // Reads (`GET`) are support-tier: they ride the parent admin stack's
  // `requireStaff('support')` blanket (GET, non-CSV, non-Discord — the
  // ADR-037 matrix shape), so no explicit gate is needed here. Literal
  // `/api/admin/holds` is a distinct method+path from the param routes;
  // no mount-order collision.
  app.post(
    '/api/admin/users/:userId/holds',
    rateLimit('POST /api/admin/users/:userId/holds', 20, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('account-freeze'),
    adminPlaceAccountHoldHandler,
  );
  app.post(
    '/api/admin/holds/:holdId/release',
    rateLimit('POST /api/admin/holds/:holdId/release', 20, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('account-unfreeze'),
    adminReleaseAccountHoldHandler,
  );
  app.get(
    '/api/admin/users/:userId/holds',
    rateLimit('GET /api/admin/users/:userId/holds', 60, 60_000),
    adminListUserAccountHoldsHandler,
  );
  app.get(
    '/api/admin/holds',
    rateLimit('GET /api/admin/holds', 60, 60_000),
    adminListActiveAccountHoldsHandler,
  );
}
