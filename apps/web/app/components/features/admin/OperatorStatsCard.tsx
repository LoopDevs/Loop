import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getOperatorStats, type OperatorStatsRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const WINDOW_HOURS = 24;

/**
 * Success-rate percentage, clamped to [0, 100], rendered with one
 * decimal. Returns `—` for a zero-order operator so the column
 * doesn't print a meaningless `NaN%` when a row is empty.
 */
export function successRatePct(row: OperatorStatsRow): string {
  if (row.orderCount <= 0) return '—';
  const pct = (row.fulfilledCount / row.orderCount) * 100;
  if (!Number.isFinite(pct)) return '—';
  const clamped = Math.max(0, Math.min(100, pct));
  return `${clamped.toFixed(1)}%`;
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Per-operator stats card for /admin/treasury (ADR 013 / 022). Sits
 * alongside SupplierSpendCard: spend answers "what did we pay CTX",
 * this one answers "which CTX operator actually did the work".
 * The operator name drills into `/admin/operators/:operatorId` (the
 * full operator detail page that lands the operator-quartet
 * endpoints together); the per-row failed-count stays wired to the
 * admin/orders filter so ops can jump straight to incident triage.
 */
export function OperatorStatsCard(): React.JSX.Element {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const query = useQuery({
    queryKey: ['admin-operator-stats', WINDOW_HOURS],
    queryFn: () => getOperatorStats({ since }),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return (
      <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load operator stats.</p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No operator activity in the last {WINDOW_HOURS} hours.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Operator', 'Orders', 'Fulfilled', 'Failed', 'Success', 'Last order'].map((h) => (
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
          {query.data.rows.map((row: OperatorStatsRow) => (
            <tr key={row.operatorId}>
              <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                <Link
                  to={`/admin/operators/${encodeURIComponent(row.operatorId)}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  aria-label={`Open operator detail for ${row.operatorId}`}
                >
                  {row.operatorId}
                </Link>
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {row.orderCount.toLocaleString('en-US')}
              </td>
              <td className="px-3 py-2 tabular-nums text-green-700 dark:text-green-400">
                {row.fulfilledCount.toLocaleString('en-US')}
              </td>
              <td
                className={`px-3 py-2 tabular-nums ${
                  row.failedCount > 0
                    ? 'text-red-700 dark:text-red-400 font-medium'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {row.failedCount > 0 ? (
                  <Link
                    to={`/admin/orders?state=failed&ctxOperatorId=${encodeURIComponent(row.operatorId)}`}
                    className="hover:underline"
                    aria-label={`Review ${row.failedCount} failed orders on ${row.operatorId}`}
                  >
                    {row.failedCount.toLocaleString('en-US')}
                  </Link>
                ) : (
                  row.failedCount.toLocaleString('en-US')
                )}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {successRatePct(row)}
              </td>
              <td
                className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"
                title={row.lastOrderAt}
              >
                {fmtRelative(row.lastOrderAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
