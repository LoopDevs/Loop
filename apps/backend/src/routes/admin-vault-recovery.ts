/**
 * `/api/admin/vault-{emissions,redemptions}/:id/redrive` route mounts
 * (ADR 031 V7 — the recovery complement to the V5a stuck-watchdog
 * page). Two routes, same shape as `admin-order-drill.ts`'s A5-1
 * `/orders/:orderId/redrive` mount.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this factory
 * MUST be called AFTER the 4-piece middleware stack (cache-control /
 * requireAuth / requireAdmin / audit middleware) is in place; that's
 * the parent factory's responsibility. No literal-vs-param collision
 * risk here — both routes are single-segment `:id` params under their
 * own distinct path prefixes.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import { adminRedriveVaultEmissionHandler } from '../admin/vault-emission-redrive.js';
import { adminRedriveVaultRedemptionHandler } from '../admin/vault-redemption-redrive.js';

/**
 * Mounts the two vault-recovery `/api/admin/vault-*` routes on the
 * supplied Hono app. Called once from `mountAdminRoutes` after the
 * admin middleware stack is in place.
 */
export function mountAdminVaultRecoveryRoutes(app: Hono): void {
  // POST /api/admin/vault-emissions/:id/redrive — ADR 031 V7. Re-enters
  // the EXISTING vault-emission drive (`driveOneVaultEmission`) for a
  // `failed` (attempts-exhausted) or operator-confirmed-stuck row.
  // Admin-tier + step-up: like order-redrive, this can submit a real
  // outbound Soroban deposit/transfer call. 10/min — matches
  // order-redrive's cadence (every call can be a real on-chain
  // submit + confirm round trip).
  app.post(
    '/api/admin/vault-emissions/:id/redrive',
    rateLimit('POST /api/admin/vault-emissions/:id/redrive', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('vault-redrive'),
    adminRedriveVaultEmissionHandler,
  );
  // POST /api/admin/vault-redemptions/:id/redrive — ADR 031 V7. Same
  // shape, re-entering `driveOneVaultRedemption`; additionally refuses
  // (409) a needs-refund row rather than silently re-attempting a
  // payout — see the handler's doc comment.
  app.post(
    '/api/admin/vault-redemptions/:id/redrive',
    rateLimit('POST /api/admin/vault-redemptions/:id/redrive', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('vault-redrive'),
    adminRedriveVaultRedemptionHandler,
  );
}
