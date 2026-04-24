import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getMerchantOperatorMix, type MerchantOperatorMixRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

const WINDOW_HOURS = 24;

/**
 * Success-rate percentage rounded to 1dp. `—` for zero-order rows
 * so the column doesn't print a meaningless `NaN%`.
 */
function successPct(row: MerchantOperatorMixRow): string {
  if (row.orderCount <= 0) return '—';
  const pct = (row.fulfilledCount / row.orderCount) * 100;
  if (!Number.isFinite(pct)) return '—';
  return `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
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
 * Per-merchant operator-mix card for `/admin/merchants/:merchantId`
 * (ADR 013 / 022). Shows which CTX operators have been carrying
 * this merchant's orders over the last 24h — the triage view ops
 * needs during incidents ("merchant X is slow — which operator is
 * primarily carrying them?").
 *
 * Each row drills into the per-operator detail page for a full
 * picture of that operator; failed-count cell short-circuits to
 * the admin/orders filter pre-scoped to (merchant, operator,
 * state=failed) for direct incident triage.
 */
export function MerchantOperatorMixCard({ merchantId }: { merchantId: string }): React.JSX.Element {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const query = useQuery({
    queryKey: ['admin-merchant-operator-mix', merchantId, WINDOW_HOURS],
    queryFn: () => getMerchantOperatorMix(merchantId, { since }),
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
      <p className="px-6 py-6 text-sm text-red-600 dark:text-red-400">
        Failed to load operator mix for this merchant.
      </p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">
        No operator has carried an order for this merchant in the last {WINDOW_HOURS} hours.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Operator', 'Orders', 'Fulfilled', 'Failed', 'Success', 'Last order'].map((h) => (
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
          {query.data.rows.map((r) => (
            <tr key={r.operatorId}>
              <td className="px-6 py-2 font-medium text-gray-900 dark:text-white">
                <Link
                  to={`/admin/operators/${encodeURIComponent(r.operatorId)}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  aria-label={`Open operator detail for ${r.operatorId}`}
                >
                  {r.operatorId}
                </Link>
              </td>
              <td className="px-6 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {r.orderCount.toLocaleString(ADMIN_LOCALE)}
              </td>
              <td className="px-6 py-2 tabular-nums text-green-700 dark:text-green-400">
                {r.fulfilledCount.toLocaleString(ADMIN_LOCALE)}
              </td>
              <td
                className={`px-6 py-2 tabular-nums ${
                  r.failedCount > 0
                    ? 'text-red-700 dark:text-red-400 font-medium'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {r.failedCount > 0 ? (
                  <Link
                    to={`/admin/orders?state=failed&merchantId=${encodeURIComponent(merchantId)}&ctxOperatorId=${encodeURIComponent(r.operatorId)}`}
                    className="hover:underline"
                    aria-label={`Review ${r.failedCount} failed orders on ${r.operatorId} for this merchant`}
                  >
                    {r.failedCount.toLocaleString(ADMIN_LOCALE)}
                  </Link>
                ) : (
                  r.failedCount.toLocaleString(ADMIN_LOCALE)
                )}
              </td>
              <td className="px-6 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {successPct(r)}
              </td>
              <td
                className="px-6 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"
                title={r.lastOrderAt}
              >
                {fmtRelative(r.lastOrderAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
