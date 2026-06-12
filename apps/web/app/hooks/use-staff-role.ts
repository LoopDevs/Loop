/**
 * `useStaffRole` — resolves the signed-in user's ADR 037 staff role.
 *
 * Single source of truth for role-aware rendering across the admin
 * shell: `RequireStaff` gates whole routes on it, `AdminNav` filters
 * tabs with it, and shared views use `isAdminRole` to decide whether
 * money-write forms / CSV exports render at all (hidden, never
 * disabled — support must not see surfaces it can't use).
 *
 * Mechanism: the web learns admin-ness from `GET /api/users/me`
 * (`UserMeView`) — the same `['me']` TanStack cache line RequireAdmin
 * has used since A2-1101, so this hook adds no extra fetch. ADR 037's
 * backend sibling adds `staffRole: 'admin' | 'support' | null` to
 * that payload; while the rollout completes we fall back to the
 * deprecated `isAdmin` boolean (`isAdmin: true` → `'admin'`), which
 * preserves today's behaviour against an older backend.
 */
import { useQuery } from '@tanstack/react-query';
import type { StaffRole, UserMeView } from '@loop/shared';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getMe } from '~/services/user';

export interface StaffRoleState {
  /** Resolved role; `null` = not staff (or not signed in / unresolved). */
  staffRole: StaffRole | null;
  /** True only for the admin role — gates money writes / CSV / staff mgmt. */
  isAdminRole: boolean;
  /** True for either staff role. */
  isStaff: boolean;
  /** `['me']` still in flight (only while authenticated). */
  isPending: boolean;
}

/** Pure resolver, exported for tests: payload → effective role. */
export function resolveStaffRole(me: UserMeView | undefined): StaffRole | null {
  if (me === undefined) return null;
  // `?? null` also coalesces `undefined` from a pre-ADR-037 backend
  // that doesn't emit the field yet.
  const fromField = me.staffRole ?? null;
  if (fromField !== null) return fromField;
  return me.isAdmin ? 'admin' : null;
}

export function useStaffRole(): StaffRoleState {
  const { isAuthenticated } = useAuth();

  const me = useQuery<UserMeView, Error>({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    // Mirrors RequireAdmin: roles don't flip mid-session; a 15-min
    // token TTL bounds revocation anyway (ADR 037 §2).
    staleTime: 5 * 60 * 1000,
  });

  const staffRole = resolveStaffRole(me.data);
  return {
    staffRole,
    isAdminRole: staffRole === 'admin',
    isStaff: staffRole !== null,
    isPending: isAuthenticated && me.isPending,
  };
}
