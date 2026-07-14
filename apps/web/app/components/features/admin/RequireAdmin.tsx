import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiException, type StaffRole } from '@loop/shared';
import { useAuth } from '~/hooks/use-auth';
import { useAuthStore } from '~/stores/auth.store';
import { shouldRetry } from '~/hooks/query-retry';
import { resolveStaffRole } from '~/hooks/use-staff-role';
import { getMe, type UserMeView } from '~/services/user';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';

/**
 * Client-side guard for every `/admin/*` route (A2-1101, extended by
 * ADR 037 to the two-tier staff model).
 *
 * Prior shape: each page rendered `<AdminNav />` + page content
 * unconditionally, then let its own data fetch surface the 401/403
 * banner on auth failure. A non-admin navigating to any subpage
 * briefly flashed the admin nav before the banner replaced it —
 * visual noise that also leaked "this is an admin surface" to users
 * who were never supposed to see it.
 *
 * `RequireStaff` gates the whole shell on the role resolved from
 * `/api/users/me` (`staffRole`, falling back to the deprecated
 * `isAdmin` boolean — see `useStaffRole`) and only renders children
 * when the caller meets `minimum`:
 *
 *   - `minimum="admin"`   → admin role only (money writes, CSV mass
 *     exports, staff management — ADR 037 §3).
 *   - `minimum="support"` → admin or support (read views + the three
 *     delivery-unsticking actions).
 *
 * Session-restore in flight → spinner (FE-10): the access token is
 * memory-only, so on a hard reload it's briefly null for an already-
 * authenticated staff user while the boot refresh runs. We wait on the
 * auth store's `restoreComplete` flag before deciding, so the sign-in
 * CTA never flashes mid-restore. Unauthenticated (restore done) →
 * sign-in CTA. Authenticated but under-privileged → denial banner, no
 * nav (mirrors the backend's 404-not-403 concealment). Loading → spinner.
 * Backend 401/403 → treated as denied (covers the case where `/me` is
 * unreachable because the session just expired).
 *
 * The `/me` query is also how the index route and `AdminNav` learn
 * the role, so the TanStack cache line is shared across the whole
 * admin surface.
 */
export function RequireStaff({
  minimum,
  children,
}: {
  minimum: StaffRole;
  children: React.ReactNode;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  // FE-10: has the cold-boot refresh-token restore attempt finished?
  // (set by `useSessionRestore` — see `restoreComplete` in auth.store).
  const restoreComplete = useAuthStore((s) => s.restoreComplete);

  const me = useQuery<UserMeView, Error>({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    // 5 minutes — the staff role doesn't flip mid-session; a user
    // promoted/demoted re-authenticates anyway (ADR 037 §2 pins
    // revocation latency to the 15-min token TTL regardless).
    staleTime: 5 * 60 * 1000,
  });

  // FE-10: on a hard reload the access token (memory-only, never
  // persisted) is briefly null for an already-authenticated staff user
  // while the refresh-token restore is in flight. Rendering the sign-in
  // CTA in that window flashes it before the session resolves. Hold the
  // neutral loading spinner until the boot-restore attempt completes;
  // only *then* does a genuinely-unauthenticated user fall through to
  // the sign-in CTA below. Server render and first client paint both
  // start with `restoreComplete === false` + `accessToken === null`, so
  // both render this spinner — the states agree, no hydration mismatch.
  if (!isAuthenticated && !restoreComplete) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-12 flex justify-center">
        <Spinner />
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin</h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in with a staff account.</p>
        <Button
          onClick={() => {
            void navigate('/auth');
          }}
        >
          Sign in
        </Button>
      </main>
    );
  }

  if (me.isPending) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-12 flex justify-center">
        <Spinner />
      </main>
    );
  }

  // Failing open on a transient /me error would flash the admin shell
  // to a signed-in non-staff user who just got a blip — gate on the
  // typed response rather than the error branch.
  const role = resolveStaffRole(me.data);
  const denied =
    (me.error instanceof ApiException && (me.error.status === 401 || me.error.status === 403)) ||
    !(role === 'admin' || (minimum === 'support' && role === 'support'));

  if (denied) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <section
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {minimum === 'admin'
            ? 'Admin access required. The signed-in account does not hold the admin role.'
            : 'Staff access required. The signed-in account does not hold a staff role.'}
        </section>
      </main>
    );
  }

  return <>{children}</>;
}

/**
 * A2-1101 shim: the original admin-only gate, now `RequireStaff`
 * with `minimum="admin"`. Kept so the admin-only routes (cashback
 * config, operators, assets, audit, stuck-orders, staff management)
 * don't churn their imports.
 */
export function RequireAdmin({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <RequireStaff minimum="admin">{children}</RequireStaff>;
}
