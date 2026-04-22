import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import type { Route } from './+types/admin.users.$userId';
import { useAuth } from '~/hooks/use-auth';
import { getAdminUser, type AdminUserView } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · User — Loop' }];
}

/**
 * Minor-unit bigint-string → home-currency-formatted decimal. Kept
 * local (not shared) because only two admin pages format home-currency
 * values today and both have their own variant. A follow-up consolidates
 * these into `@loop/shared/money` once the helper shape stabilises.
 */
function fmtMinor(minor: string, currency: string): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const sign = negative ? '-' : '';
  const symbol =
    currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '';
  return `${sign}${symbol}${Number(whole).toLocaleString('en-US')}.${fraction} ${currency}`;
}

/** Abbreviated Stellar pubkey for UI display — G...xyz. */
function truncPubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

/**
 * `/admin/users/:userId` — admin user drill-down (ADR 011 / 015).
 *
 * Renders the one-shot summary from `GET /api/admin/users/:userId`
 * (identity, balance, lifetime cashback, counts) alongside two
 * deep-links into the existing paginated admin views:
 *   - /admin/orders?userId=X — every order by this user
 *   - /admin/payouts?userId=X — every payout tied to this user
 *
 * Landing here from those pages and back again is how an admin
 * triages a specific user across order/payout/balance states.
 */
export default function AdminUserRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const params = useParams();
  const userId = params['userId'] ?? '';

  const query = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () => getAdminUser(userId),
    enabled: isAuthenticated && userId.length > 0,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin · User</h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in with an admin account.</p>
        <button
          type="button"
          className="text-blue-600 underline"
          onClick={() => {
            void navigate('/auth');
          }}
        >
          Go to sign-in
        </button>
      </main>
    );
  }

  if (query.isPending) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12 flex justify-center">
        <Spinner />
      </main>
    );
  }

  if (query.isError) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin · User</h1>
        <p className="text-red-600 dark:text-red-400">
          Failed to load user. The id may be wrong, or you may not be an admin.
        </p>
      </main>
    );
  }

  const user: AdminUserView = query.data.user;

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-8">
      <AdminNav />

      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide font-semibold text-gray-500 dark:text-gray-400">
          Admin · User
        </p>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white break-all">
          {user.email}
        </h1>
        <div className="flex flex-wrap gap-2 text-xs">
          {user.isAdmin ? (
            <span className="rounded-full px-2.5 py-0.5 font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
              admin
            </span>
          ) : null}
          <span className="rounded-full px-2.5 py-0.5 font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            home · {user.homeCurrency}
          </span>
          <span className="font-mono text-gray-500 dark:text-gray-400">{user.id}</span>
        </div>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Balance</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
            {fmtMinor(user.balanceMinor, user.homeCurrency)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            What Loop owes this user right now.
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Lifetime cashback earned
          </div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
            {fmtMinor(user.lifetimeCashbackEarnedMinor, user.homeCurrency)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Cashback credited since signup. Withdrawals don&apos;t reduce this.
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Account details
        </h2>
        <dl className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-900 text-sm">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500 dark:text-gray-400">Stellar address</dt>
            <dd className="font-mono text-gray-900 dark:text-white">
              {user.stellarAddress === null ? (
                <span className="text-gray-500 dark:text-gray-400">not linked</span>
              ) : (
                truncPubkey(user.stellarAddress)
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-gray-500 dark:text-gray-400">Signed up</dt>
            <dd className="text-gray-900 dark:text-white">
              {new Date(user.createdAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Activity</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link
            to={`/admin/orders?userId=${encodeURIComponent(user.id)}`}
            className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Orders</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {user.orderCount}
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">See all orders →</div>
          </Link>
          <Link
            to={`/admin/payouts?userId=${encodeURIComponent(user.id)}`}
            className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Open payouts</div>
            <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {user.pendingPayoutCount}
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">See all payouts →</div>
          </Link>
        </div>
      </section>
    </main>
  );
}
