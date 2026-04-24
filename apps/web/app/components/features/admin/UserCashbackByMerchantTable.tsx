import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  getAdminUserCashbackByMerchant,
  type AdminUserCashbackByMerchantRow,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * Minor-unit string → localised currency, with an em-dash fallback
 * for malformed backend input. Identical shape to the user-facing
 * variant; inlined here to keep the two surfaces independently
 * refactorable while the pattern stabilises.
 */
export function fmtCashback(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(ADMIN_LOCALE, { style: 'currency', currency }).format(n / 100);
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
 * Admin per-user cashback-by-merchant table. Sits on the user detail
 * page alongside the credit-balance card and the credit-transactions
 * log. Answers the most common support question — "why haven't I
 * earned cashback on merchant X?" — by showing which merchants this
 * specific user has actually earned from.
 *
 * Each row's merchant id links to the admin orders list scoped
 * `?merchantId=<id>&userId=<id>` so ops can see the actual orders
 * behind the aggregate. Non-error empty state shows a friendly
 * "no cashback yet" line rather than hiding (admin needs the
 * negative answer for triage).
 */
export function UserCashbackByMerchantTable({ userId }: { userId: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-user-cashback-by-merchant', userId],
    queryFn: () => getAdminUserCashbackByMerchant(userId, { limit: 25 }),
    enabled: userId.length > 0,
    retry: shouldRetry,
    staleTime: 30_000,
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
      <p className="py-4 text-sm text-red-600 dark:text-red-400">
        Failed to load cashback breakdown.
      </p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No cashback earned in the last 180 days.
      </p>
    );
  }

  const currency = query.data.currency;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['Merchant', 'Orders', 'Cashback', 'Last earned'].map((h) => (
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
          {query.data.rows.map((row: AdminUserCashbackByMerchantRow) => (
            <tr key={row.merchantId}>
              <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                <Link
                  to={`/admin/orders?merchantId=${encodeURIComponent(
                    row.merchantId,
                  )}&userId=${encodeURIComponent(userId)}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  aria-label={`Orders for ${row.merchantId} on this user`}
                >
                  {row.merchantId}
                </Link>
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {row.orderCount.toLocaleString(ADMIN_LOCALE)}
              </td>
              <td className="px-3 py-2 tabular-nums font-medium text-green-700 dark:text-green-400">
                +{fmtCashback(row.cashbackMinor, currency)}
              </td>
              <td
                className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400"
                title={row.lastEarnedAt}
              >
                {fmtRelative(row.lastEarnedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
