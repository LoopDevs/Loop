import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.users.$userId';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getAdminUser, getAdminUserCredits, type AdminUserCreditRow } from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { CreditAdjustmentForm } from '~/components/features/admin/CreditAdjustmentForm';
import { CreditTransactionsTable } from '~/components/features/admin/CreditTransactionsTable';
import { UserCashbackByMerchantTable } from '~/components/features/admin/UserCashbackByMerchantTable';
import { UserOrdersTable } from '~/components/features/admin/UserOrdersTable';
import { UserPayoutsTable } from '~/components/features/admin/UserPayoutsTable';
import { Spinner } from '~/components/ui/Spinner';

const HOME_CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
type HomeCurrency = (typeof HOME_CURRENCIES)[number];

function isHomeCurrency(s: string): s is HomeCurrency {
  return (HOME_CURRENCIES as readonly string[]).includes(s);
}

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · User — Loop' }];
}

/**
 * Formats minor-unit balance as a localised currency string. Uses
 * Intl.NumberFormat so it renders correctly for GBP / USD / EUR
 * without a hand-rolled symbol map. Non-finite amounts render as
 * `—` so a bad backend response doesn't print "NaN" in the UI.
 */
function fmtMinor(balanceMinor: string, currency: string): string {
  const n = Number(balanceMinor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n / 100);
  } catch {
    // Unknown ISO currency code → fall back to a plain decimal + code suffix.
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * `/admin/users/:userId` — user detail + credit-balance drill.
 *
 * Two parallel queries: the user row itself (for the header card)
 * and the per-currency credit balances (for the balance table).
 * TanStack caches both — a drill from /admin/users reuses the list
 * page's cache miss isn't retraversed.
 *
 * The credit-adjustment form + the credit-transactions log are
 * follow-up slices (ADR 017 backend is already live).
 */
export default function AdminUserDetailRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { userId } = useParams<{ userId: string }>();
  const { isAuthenticated } = useAuth();

  const userQuery = useQuery({
    queryKey: ['admin-user', userId ?? null],
    queryFn: () => getAdminUser(userId ?? ''),
    enabled: isAuthenticated && userId !== undefined && userId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  const creditsQuery = useQuery({
    queryKey: ['admin-user-credits', userId ?? null],
    queryFn: () => getAdminUserCredits(userId ?? ''),
    enabled: isAuthenticated && userId !== undefined && userId.length > 0,
    retry: shouldRetry,
    staleTime: 15_000,
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

  // 404 body is used by both the user fetch (user not found) and the
  // credits fetch (shouldn't happen if the user exists, but handle
  // defensively — surface the same copy either way).
  const userNotFound = userQuery.error instanceof ApiException && userQuery.error.status === 404;

  return (
    <main className="max-w-4xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <nav aria-label="Back to user list">
        <Link
          to="/admin/users"
          className="text-sm text-gray-600 hover:underline dark:text-gray-400"
        >
          ← All users
        </Link>
      </nav>

      {userQuery.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">User not found</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            No user with id <code className="font-mono text-xs">{userId}</code>. The row may have
            been deleted, or the link is wrong.
          </p>
        </section>
      ) : userQuery.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load user. You may not be an admin.
        </p>
      ) : (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
                {userQuery.data.email}
              </h1>
              <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
                {userQuery.data.id}
                <CopyButton text={userQuery.data.id} label="Copy user id" />
              </p>
            </div>
            {userQuery.data.isAdmin ? (
              <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                admin
              </span>
            ) : null}
          </header>
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Home currency</dt>
              <dd className="text-gray-900 dark:text-white">{userQuery.data.homeCurrency}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Stellar address</dt>
              <dd className="text-gray-900 dark:text-white font-mono text-xs break-all">
                {userQuery.data.stellarAddress ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">CTX user id</dt>
              <dd className="text-gray-900 dark:text-white font-mono text-xs break-all">
                {userQuery.data.ctxUserId ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Signed up</dt>
              <dd className="text-gray-900 dark:text-white">
                {new Date(userQuery.data.createdAt).toLocaleString('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Credit balances</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Off-chain ledger balances per currency (ADR 009 / 015). Adjustments are applied via the
            form below and land as signed <code className="font-mono">credit_transactions</code>{' '}
            rows.
          </p>
        </header>
        {creditsQuery.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : creditsQuery.isError ? (
          <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
            Failed to load credit balances.
          </p>
        ) : creditsQuery.data.rows.length === 0 ? (
          <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">
            No credit balances for this user yet.
          </p>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
            <thead>
              <tr>
                {['Currency', 'Balance', 'Last updated'].map((h) => (
                  <th
                    key={h}
                    className="px-6 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
              {creditsQuery.data.rows.map((c: AdminUserCreditRow) => (
                <tr key={c.currency}>
                  <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">
                    {c.currency}
                  </td>
                  <td className="px-6 py-3 tabular-nums text-gray-900 dark:text-white">
                    {fmtMinor(c.balanceMinor, c.currency)}
                  </td>
                  <td className="px-6 py-3 whitespace-nowrap text-gray-600 dark:text-gray-400">
                    {new Date(c.updatedAt).toLocaleString('en-US', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {userQuery.data !== undefined && !userNotFound && userId !== undefined ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Apply adjustment (ADR 017)
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Positive amount credits the user; negative amount debits. A debit that would drive the
              balance below zero returns <code className="font-mono">409</code> —
              InsufficientBalanceError. Every submission is idempotent on the browser-generated key
              and fires a Discord audit after commit.
            </p>
          </header>
          <div className="px-6 py-5">
            <CreditAdjustmentForm
              userId={userId}
              defaultCurrency={
                isHomeCurrency(userQuery.data.homeCurrency) ? userQuery.data.homeCurrency : 'USD'
              }
            />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Recent orders</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The user&rsquo;s last 25 Loop-native orders (ADR 011/015). Click an id for the full
              state + cashback-split + timeline drill-down.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserOrdersTable userId={userId} />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Recent on-chain payouts
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Stellar cashback emissions for this user (ADR 015/016). Each row links to the payout
              detail for tx hash + Stellar Expert + retry controls.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserPayoutsTable userId={userId} />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Cashback by merchant
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Which merchants this user has earned cashback from in the last 180 days (ADR 009/015).
              Support triage: answers &ldquo;why haven&rsquo;t I earned on merchant X?&rdquo; with
              the authoritative ledger view. Clicking a merchant deep-links to the orders list
              scoped to that user + merchant.
            </p>
          </header>
          <div className="px-6 py-5">
            <UserCashbackByMerchantTable userId={userId} />
          </div>
        </section>
      ) : null}

      {userId !== undefined && !userNotFound ? (
        <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Credit transactions
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Append-only ledger (ADR 009). Filter by type; page with the buttons below.
            </p>
          </header>
          <div className="px-6 py-5">
            <CreditTransactionsTable userId={userId} />
          </div>
        </section>
      ) : null}
    </main>
  );
}
