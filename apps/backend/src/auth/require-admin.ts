import { requireStaff } from './require-staff.js';

/**
 * Admin-only middleware — since ADR 037 an alias for
 * `requireStaff('admin')` (see auth/require-staff.ts for the full
 * resolution contract). Kept as its own export so every
 * pre-ADR-037 import site keeps compiling and keeps its exact
 * semantics:
 *
 *   - 401 when unauthenticated / legacy-CTX bearer / token points
 *     at no user row
 *   - 500 when the user lookup throws
 *   - 404 (never 403) when authenticated but not an admin —
 *     don't leak the existence of the admin surface
 *   - on success: `c.get('user')` returns the resolved User row
 *     (and `c.get('staffRole')` is 'admin')
 *
 * Authorization sources: `staff_roles` row when present (ADR 037),
 * falling back to the deprecated `users.is_admin` shim (the
 * `ADMIN_CTX_USER_IDS` upsert path) when no row exists.
 */
export const requireAdmin = requireStaff('admin');
