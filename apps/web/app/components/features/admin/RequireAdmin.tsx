import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiException } from '@loop/shared';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getMe, type UserMeView } from '~/services/user';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';

/**
 * Client-side guard for every `/admin/*` route (A2-1101).
 *
 * Prior shape: each page rendered `<AdminNav />` + page content
 * unconditionally, then let its own data fetch surface the 401/403
 * banner on auth failure. A non-admin navigating to any subpage
 * briefly flashed the admin nav before the banner replaced it —
 * visual noise that also leaked "this is an admin surface" to users
 * who were never supposed to see it.
 *
 * This component gates the whole shell on `/api/users/me.isAdmin`
 * and only renders children when the gate resolves to `allowed`.
 * Unauthenticated → sign-in CTA. Authenticated but non-admin → the
 * banner the audit asked for, no nav. Loading → spinner. Backend
 * 401/403 → treat as denied (covers the case where `/me` is
 * unreachable because the session just expired).
 *
 * The `/me` query is also how the index route learns `isAdmin`, so
 * the TanStack cache line is shared across the whole admin surface.
 */
export function RequireAdmin({ children }: { children: React.ReactNode }): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const me = useQuery<UserMeView, Error>({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: isAuthenticated,
    retry: shouldRetry,
    // 5 minutes — the admin role doesn't flip mid-session; a user
    // promoted/demoted re-authenticates anyway.
    staleTime: 5 * 60 * 1000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin</h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in with an admin account.</p>
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
  // to a signed-in non-admin who just got a blip — gate on the typed
  // response rather than the error branch.
  const denied =
    me.data === undefined ||
    me.data.isAdmin === false ||
    (me.error instanceof ApiException && (me.error.status === 401 || me.error.status === 403));

  if (denied) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <section
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          Admin access required. The signed-in account is not marked as admin.
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
