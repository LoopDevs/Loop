/**
 * `/api/admin/rails/*` route mounts (NS-04 — runtime rail kill switches).
 *
 * Three routes backing the admin rail-halt surface: list all four rails'
 * state (read), halt a rail, resume a rail. The two writes carry the
 * canonical audited-admin-write stack — rate-limit → `requireStaff('admin')`
 * → `requireAdminStepUp(scope)` → handler (`withIdempotencyGuard` +
 * `buildAuditEnvelope` + `notifyAdminAudit`) — matching
 * `mountAdminCreditWritesRoutes`.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this factory MUST
 * be called AFTER the 4-piece middleware stack (cache-control /
 * requireAuth / requireStaff('support') / audit middleware) is in place;
 * that's the parent factory's responsibility. `requireStaff('admin')` on
 * each mount narrows the support-tier blanket to admin-only.
 *
 * Literal `/rails/kill-switches` is registered BEFORE the `/rails/:rail/*`
 * param routes so Hono's router doesn't resolve `kill-switches` as a
 * `:rail` value (it isn't a known rail, but keeping literals first matches
 * the repo's mount-order discipline).
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import {
  adminListRailKillSwitchesHandler,
  adminHaltRailHandler,
  adminResumeRailHandler,
} from '../admin/rail-kill-switches.js';

/**
 * Mounts the `/api/admin/rails/*` routes on the supplied Hono app.
 * Called once from `mountAdminRoutes` after the admin middleware stack
 * is in place.
 */
export function mountAdminRailsRoutes(app: Hono): void {
  // List all four rails' current halt state (admin read). The
  // `/api/admin/*` blanket already audit-logs the GET.
  app.get(
    '/api/admin/rails/kill-switches',
    rateLimit('GET /api/admin/rails/kill-switches', 60, 60_000),
    requireStaff('admin'),
    adminListRailKillSwitchesHandler,
  );
  // Halt a rail — rejects NEW ops at the rail's entry point (block-new-
  // only; in-flight work runs to completion). Destructive money-flow
  // control, so step-up (`rail-halt`) + idempotency + mandatory reason.
  app.post(
    '/api/admin/rails/:rail/halt',
    rateLimit('POST /api/admin/rails/:rail/halt', 20, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('rail-halt'),
    adminHaltRailHandler,
  );
  // Resume a rail — re-enables new ops. Also step-up gated
  // (`rail-resume`): re-enabling money movement mid-incident is itself a
  // deliberate, audited action, and a captured bearer must not be able
  // to silently un-halt a rail an operator stopped.
  app.post(
    '/api/admin/rails/:rail/resume',
    rateLimit('POST /api/admin/rails/:rail/resume', 20, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('rail-resume'),
    adminResumeRailHandler,
  );
}
