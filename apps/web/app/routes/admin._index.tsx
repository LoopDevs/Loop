import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin._index';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getTreasurySnapshot, type TreasurySnapshot } from '~/services/admin';
import {
  AdminNav,
  failedPayoutsCount,
  operatorPoolStatus,
} from '~/components/features/admin/AdminNav';
import { AdminAuditTail } from '~/components/features/admin/AdminAuditTail';
import { ConfigsHistoryCard } from '~/components/features/admin/ConfigsHistoryCard';
import { CashbackSparkline } from '~/components/features/admin/CashbackSparkline';
import { OrdersSparkline } from '~/components/features/admin/OrdersSparkline';
import { StuckOrdersCard } from '~/components/features/admin/StuckOrdersCard';
import { StuckPayoutsCard } from '~/components/features/admin/StuckPayoutsCard';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin — Loop' }];
}

interface CardLink {
  href: string;
  title: string;
  description: string;
}

const CARDS: ReadonlyArray<CardLink> = [
  {
    href: '/admin/treasury',
    title: 'Treasury',
    description:
      'Outstanding credit, LOOP liabilities, operator pool health, payout counts, per-asset breakdown.',
  },
  {
    href: '/admin/payouts',
    title: 'Payouts',
    description: 'Stellar cashback backlog (ADR 015/016). Retry failed rows with Discord audit.',
  },
  {
    href: '/admin/orders',
    title: 'Orders',
    description: 'Loop-native orders drill-down with state + cashback split (ADR 011/015).',
  },
  {
    href: '/admin/cashback',
    title: 'Cashback',
    description: 'Per-merchant wholesale / cashback / margin config + audit trail (ADR 011).',
  },
  {
    href: '/admin/users',
    title: 'Users',
    description: 'Paginated user directory with email search + credit drill-down (ADR 009/017).',
  },
  {
    href: '/admin/stuck-orders',
    title: 'Stuck orders',
    description:
      'SLO-triage list for orders sitting past threshold in paid / procuring (ADR 011/013).',
  },
];

/**
 * `/admin` landing — the tabs in AdminNav deep-link into subpages;
 * this index is the first thing an op sees when they navigate to the
 * admin root. Renders high-signal "is anything on fire right now?"
 * cards from the treasury snapshot (operator-pool state, failed
 * payouts count) followed by navigation cards into every subpage.
 *
 * Auth gate deliberately matches the subpages: show a sign-in CTA
 * when logged out; the 401/403 from the treasury fetch is how we
 * tell the caller isn't an admin.
 */
export default function AdminIndexRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const snapshotQuery = useQuery<TreasurySnapshot, Error>({
    queryKey: ['admin-treasury'],
    queryFn: getTreasurySnapshot,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">Admin</h1>
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

  const denied =
    snapshotQuery.error instanceof ApiException &&
    (snapshotQuery.error.status === 401 || snapshotQuery.error.status === 404);
  const status = operatorPoolStatus(snapshotQuery.data?.operatorPool);
  const failed = failedPayoutsCount(snapshotQuery.data?.payouts);

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-8">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Cashback operations hub. Use the tabs above or the cards below to drill into each surface.
        </p>
      </header>

      {denied ? (
        <section
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          Admin access required. The signed-in account is not marked as admin.
        </section>
      ) : snapshotQuery.isPending ? (
        <section className="rounded-xl border border-gray-200 bg-white px-4 py-6 dark:border-gray-800 dark:bg-gray-900 flex justify-center">
          <Spinner />
        </section>
      ) : snapshotQuery.isError ? (
        <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          Failed to load the treasury snapshot.
        </section>
      ) : (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Link
            to="/admin/treasury"
            className="rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Supplier</div>
            <div className="mt-1 text-base font-semibold text-gray-900 dark:text-white capitalize">
              CTX {status}
            </div>
          </Link>
          <Link
            to="/admin/payouts?state=failed"
            className={`rounded-xl border p-4 ${
              failed > 0
                ? 'border-red-200 bg-red-50 hover:border-red-400 dark:border-red-900/60 dark:bg-red-900/20 dark:hover:border-red-700'
                : 'border-gray-200 bg-white hover:border-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600'
            }`}
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Failed payouts
            </div>
            <div
              className={`mt-1 text-base font-semibold ${
                failed > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-900 dark:text-white'
              } tabular-nums`}
            >
              {failed}
            </div>
          </Link>
          <StuckOrdersCard />
          <StuckPayoutsCard />
        </section>
      )}

      {denied ? null : <CashbackSparkline />}

      {denied ? null : <OrdersSparkline />}

      {denied ? null : <AdminAuditTail />}

      {denied ? null : <ConfigsHistoryCard />}

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            to={card.href}
            className="rounded-xl border border-gray-200 bg-white p-5 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600"
          >
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">{card.title}</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{card.description}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
