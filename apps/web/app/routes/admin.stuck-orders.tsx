import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { Route } from './+types/admin.stuck-orders';
import { useAuth } from '~/hooks/use-auth';
import { shouldRetry } from '~/hooks/query-retry';
import { getStuckOrders, type StuckOrderRow } from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { Spinner } from '~/components/ui/Spinner';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Stuck orders — Loop' }];
}

/**
 * Returns a Tailwind class pair for the age cell. The further a row
 * sits past the SLO threshold, the louder the color — gentle yellow
 * just-over-SLO, red for chronic stalls.
 */
export function ageClass(ageMinutes: number, thresholdMinutes: number): string {
  if (ageMinutes >= thresholdMinutes * 4) {
    return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
  }
  if (ageMinutes >= thresholdMinutes * 2) {
    return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  }
  return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
}

/**
 * `/admin/stuck-orders` — SLO-triage view. The landing card shows a
 * count; this page shows the rows themselves. Clicking an id deep-
 * links to /admin/orders/:orderId for the full state + cashback-
 * split + timeline drill-down. Ops uses this page during a supplier
 * incident — paid/procuring rows piling up means the CTX operator
 * pool can't clear the backlog fast enough.
 */
export default function AdminStuckOrdersRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const query = useQuery({
    queryKey: ['admin-stuck-orders'],
    queryFn: getStuckOrders,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Stuck orders
        </h1>
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

  return (
    <main className="max-w-5xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Admin · Stuck orders
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Orders stuck in <code className="font-mono text-xs">paid</code> or{' '}
          <code className="font-mono text-xs">procuring</code> past the SLO threshold (ADR 011/013).
          Refetches every 30s so ops sees the backlog drain in real time as the CTX operator pool
          catches up.
        </p>
      </header>

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load stuck orders. You may not be an admin.
        </p>
      ) : query.data.rows.length === 0 ? (
        <section className="rounded-xl border border-green-200 bg-green-50 px-6 py-8 text-center text-sm text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-300">
          No stuck orders — everything&rsquo;s inside the {query.data.thresholdMinutes}-minute SLO.
        </section>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {['Order', 'User', 'Merchant', 'State', 'Age', 'CTX order'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-900 bg-white dark:bg-gray-900">
              {query.data.rows.map((row: StuckOrderRow) => (
                <tr key={row.id}>
                  <td className="px-3 py-2">
                    <Link
                      to={`/admin/orders/${row.id}`}
                      className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                      title={row.id}
                    >
                      {row.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/admin/users/${row.userId}`}
                      className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                      title={row.userId}
                    >
                      {row.userId.slice(0, 8)}
                    </Link>
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300"
                    title={row.merchantId}
                  >
                    {row.merchantId}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                      {row.state}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${ageClass(
                        row.ageMinutes,
                        query.data.thresholdMinutes,
                      )}`}
                    >
                      {row.ageMinutes}m
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {row.ctxOrderId ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
