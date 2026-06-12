import type { Context, MiddlewareHandler } from 'hono';
import type { StaffRole } from '@loop/shared';
import type { LoopAuthContext } from './handler.js';
import { getUserById, type User } from '../db/users.js';
import { getStaffRole } from '../db/staff-roles.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'requireStaff' });

/**
 * Staff middleware factory (ADR 037). `requireStaff('support')`
 * admits both roles (admin ⊇ support); `requireStaff('admin')`
 * admits admins only — `requireAdmin` (auth/require-admin.ts) is
 * an alias for the latter, so every pre-ADR-037 mount keeps its
 * exact semantics.
 *
 * Layered on top of `requireAuth` so the `auth` context value is
 * already set. Only Loop-verified auth contexts are eligible —
 * legacy CTX pass-through bearers are not cryptographically
 * anchored on this service and must not drive local authz
 * decisions (401).
 *
 * Role resolution (ADR 037 §1/§2):
 *   1. `staff_roles` row — authoritative when present.
 *   2. Legacy shim — `users.is_admin` ⇒ 'admin' when no row exists
 *      (CTX-allowlist admins; rows created before migration 0042
 *      ran are seeded by it).
 *   3. Neither ⇒ not staff ⇒ 404, NOT 403 — don't leak the
 *      existence of the admin surface to a non-staff authenticated
 *      user. A wrong-TIER staff request (support hitting an
 *      admin-only mount) is also 404 for the same reason.
 *
 * If the `staff_roles` read itself fails, the resolver falls back
 * to the legacy shim (pre-ADR-037 semantics) instead of failing the
 * request: admins flagged `is_admin` keep access, support users
 * fail CLOSED to 404. The window where a row-demoted admin whose
 * `is_admin` mirror is still true regains admin during such an
 * outage is accepted and logged loudly — the grant/revoke writers
 * keep the mirror in sync precisely to keep that window empty.
 *
 * On success sets `c.get('user')` (the resolved User row) and
 * `c.get('staffRole')` (the resolved role, for handler-side
 * redaction). When the chain already resolved both (the
 * `/api/admin/*` blanket runs before the per-mount gates), the
 * cached values are reused — no second DB round-trip.
 */
export function requireStaff(minimum: StaffRole): MiddlewareHandler {
  const mw = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const auth = c.get('auth') as LoopAuthContext | undefined;
    if (auth === undefined) {
      // requireAuth should have run before us. If it didn't, fail
      // closed — a staff endpoint must never be reachable without
      // auth state on the context.
      return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }
    if (auth.kind !== 'loop') {
      return c.json(
        { code: 'UNAUTHORIZED', message: 'Loop-authenticated admin session required' },
        401,
      );
    }

    let role = c.get('staffRole') as StaffRole | undefined;
    const cachedUser = c.get('user') as User | undefined;
    if (role === undefined || cachedUser === undefined) {
      let user: User;
      try {
        const resolved = await getUserById(auth.userId);
        if (resolved === null) {
          return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' }, 401);
        }
        user = resolved;
      } catch (err) {
        log.error({ err, userId: auth.userId }, 'Failed to resolve staff user');
        return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve user' }, 500);
      }

      let staffRow: { role: StaffRole } | null = null;
      let lookupFailed = false;
      try {
        staffRow = await getStaffRole(user.id);
      } catch (err) {
        // Legacy-shim fallback — see the module docstring. Support
        // fails closed (404); is_admin admins keep working.
        lookupFailed = true;
        log.warn(
          { err, userId: user.id },
          'staff_roles lookup failed — falling back to the legacy users.is_admin shim',
        );
      }
      const resolvedRole: StaffRole | null = staffRow?.role ?? (user.isAdmin ? 'admin' : null);
      if (resolvedRole === null) {
        // 404 not 403 — see docstring.
        return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
      }
      if (lookupFailed && resolvedRole === 'admin') {
        log.warn(
          { userId: user.id },
          'Admin access granted via legacy shim during staff_roles outage',
        );
      }
      role = resolvedRole;
      c.set('user', user);
      c.set('staffRole', role);
    }

    if (minimum === 'admin' && role !== 'admin') {
      // Wrong tier — same concealment as non-staff.
      return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    }

    await next();
  };
  // Named so the route-inventory test (staff-route-gating.test.ts)
  // can statically assert every /api/admin mount declares its tier.
  Object.defineProperty(mw, 'name', { value: `requireStaff(${minimum})` });
  return mw;
}
