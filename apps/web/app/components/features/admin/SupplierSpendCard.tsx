import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getSupplierSpend, type SupplierSpendRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const HOME_CURRENCIES: ReadonlySet<string> = new Set(['USD', 'GBP', 'EUR']);

const WINDOW_HOURS = 24;

/**
 * Formats a non-negative minor amount in the row's currency. Rows
 * here are always positive aggregate sums; the helper guards against
 * non-finite inputs so a bad backend row doesn't print NaN.
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

/**
 * Supplier-spend card for /admin/treasury. Surfaces the CTX-as-
 * supplier pitch: a per-currency view of what we've paid CTX in the
 * last 24h (wholesale) alongside what that money bought (face value),
 * what we gave the user back (cashback), and what's left for Loop
 * (margin). One row per charge currency active in the window.
 */
export function SupplierSpendCard(): React.JSX.Element {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const query = useQuery({
    queryKey: ['admin-supplier-spend', WINDOW_HOURS],
    queryFn: () => getSupplierSpend({ since }),
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
      <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load supplier spend.</p>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No fulfilled orders in the last {WINDOW_HOURS} hours.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {[
              'Currency',
              'Orders',
              'Face value',
              'CTX wholesale',
              'User cashback',
              'Loop margin',
              'Margin %',
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
          {query.data.rows.map((row: SupplierSpendRow) => (
            <tr key={row.currency}>
              <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                {HOME_CURRENCIES.has(row.currency) ? (
                  <Link
                    to={`/admin/orders?chargeCurrency=${row.currency}`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {row.currency}
                  </Link>
                ) : (
                  row.currency
                )}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {row.count.toLocaleString('en-US')}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {fmtMinor(row.faceValueMinor, row.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums font-medium text-gray-900 dark:text-white">
                {fmtMinor(row.wholesaleMinor, row.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums text-green-700 dark:text-green-400">
                {fmtMinor(row.userCashbackMinor, row.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums text-blue-700 dark:text-blue-400">
                {fmtMinor(row.loopMarginMinor, row.currency)}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-600 dark:text-gray-400">
                {(row.marginBps / 100).toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
