import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getTopUsers, type TopUserRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

const WINDOW_DAYS = 30;
const LIMIT = 20;

/**
 * Formats an unsigned minor amount in the row's currency. Rows here
 * are always positive cashback sums; we use `signDisplay: 'never'`
 * so "£5.00" shows without a leading "+".
 */
export function fmtPositiveMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      signDisplay: 'never',
    }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Rolling 30-day top cashback earners. Section on /admin/users
 * alongside the paginated directory — gives ops a "who's our biggest
 * earner?" and concentration-risk view without leaving the page.
 * Each row links to the user detail drill-down.
 */
export function TopUsersTable(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-top-users', WINDOW_DAYS, LIMIT],
    queryFn: () => getTopUsers({ limit: LIMIT }),
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
    return <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load top users.</p>;
  }

  if (query.data.rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No cashback activity in the last {WINDOW_DAYS} days.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['#', 'Email', 'Currency', 'Accruals', 'Earned'].map((h) => (
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
          {query.data.rows.map((r: TopUserRow, i) => (
            <tr key={`${r.userId}-${r.currency}`}>
              <td className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400">{i + 1}</td>
              <td className="px-3 py-2">
                <Link
                  to={`/admin/users/${r.userId}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {r.email}
                </Link>
              </td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{r.currency}</td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                {r.count.toLocaleString('en-US')}
              </td>
              <td className="px-3 py-2 tabular-nums font-medium text-gray-900 dark:text-white">
                {fmtPositiveMinor(r.amountMinor, r.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
