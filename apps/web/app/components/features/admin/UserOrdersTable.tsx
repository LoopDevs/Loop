import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { listAdminOrders, type AdminOrderState, type AdminOrderView } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const LIMIT = 25;

const STATE_CLASSES: Record<AdminOrderState, string> = {
  pending_payment: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  paid: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  procuring: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  fulfilled: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  expired: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

/**
 * Formats a minor-unit (pence/cent) bigint-string as localised
 * currency. Returns em-dash for non-numeric input so a bad backend
 * row doesn't surface as "NaN".
 */
export function fmtMinor(minor: string, currency: string): string {
  try {
    const major = Number(BigInt(minor)) / 100;
    if (!Number.isFinite(major)) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major);
  } catch {
    return '—';
  }
}

interface Props {
  userId: string;
}

/**
 * Shows the user's most recent admin-visible orders on
 * `/admin/users/:userId`. Uses the existing `/api/admin/orders`
 * endpoint with `?userId=` so we get the same BigInt-safe view
 * with cashback splits. Each row id links to the order detail
 * drill-down for a state + cashback + timeline view.
 */
export function UserOrdersTable({ userId }: Props): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-user-orders', userId, LIMIT],
    queryFn: () => listAdminOrders({ userId, limit: LIMIT }),
    retry: shouldRetry,
    staleTime: 10_000,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    return <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load orders.</p>;
  }

  if (query.data.orders.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No orders on this account yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['When', 'Order', 'Merchant', 'State', 'Charge', 'Cashback'].map((h) => (
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
          {query.data.orders.map((row: AdminOrderView) => (
            <tr key={row.id}>
              <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                {new Date(row.createdAt).toLocaleString('en-US', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </td>
              <td className="px-3 py-2">
                <Link
                  to={`/admin/orders/${row.id}`}
                  className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                  title={row.id}
                >
                  {row.id.slice(0, 8)}
                </Link>
              </td>
              <td
                className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300"
                title={row.merchantId}
              >
                {row.merchantId}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[row.state]}`}
                >
                  {row.state.replace('_', ' ')}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtMinor(row.chargeMinor, row.chargeCurrency)}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtMinor(row.userCashbackMinor, row.chargeCurrency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
