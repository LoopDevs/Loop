import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getMerchantStats, type MerchantStatsRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Formats a non-negative minor amount in the row's currency. Rows
 * here are always positive aggregate sums; the helper guards against
 * non-finite inputs so a bad backend row doesn't print NaN.
 */
export function fmtMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Per-merchant stats table for /admin/cashback. Sits below the
 * cashback-config editor so an admin tuning a merchant's split can
 * see the volume/margin impact on the same page. Ranked by Loop
 * margin descending — the most lucrative merchants rise to the top.
 */
export function MerchantStatsTable(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-merchant-stats'],
    queryFn: () => getMerchantStats(),
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
      <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load merchant stats.</p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No fulfilled orders in the window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {[
              'Merchant',
              'Orders',
              'Users',
              'Face value',
              'Wholesale (ours)',
              'Cashback (theirs)',
              'Loop margin',
              'Last fulfilled',
            ].map((h) => (
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
          {query.data.rows.map((r: MerchantStatsRow) => (
            <tr key={r.merchantId}>
              <td
                className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300"
                title={r.merchantId}
              >
                <Link
                  to={`/admin/orders?merchantId=${encodeURIComponent(r.merchantId)}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {r.merchantId}
                </Link>
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {r.orderCount.toLocaleString('en-US')}
              </td>
              <td
                className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300"
                title="Distinct users who earned cashback from this merchant in the window"
              >
                {r.uniqueUserCount.toLocaleString('en-US')}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtMinor(r.faceValueMinor, r.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtMinor(r.wholesaleMinor, r.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtMinor(r.userCashbackMinor, r.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums font-medium text-gray-900 dark:text-white">
                {fmtMinor(r.loopMarginMinor, r.currency)}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                {fmtRelative(r.lastFulfilledAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
