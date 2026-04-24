import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getTopUsersByPendingPayout, type TopUserByPendingPayoutEntry } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

const DEFAULT_LIMIT = 10;

/**
 * Stroops string (bigint 7-decimal integer) → human-readable asset
 * amount with the code appended. "12500000" + "GBPLOOP" →
 * "1.25 GBPLOOP". Strips trailing zeros; falls back to "—" on parse
 * failure (bigint parse throws on malformed input, we don't want
 * the whole card to error).
 */
export function fmtStroops(stroopsStr: string, code: string): string {
  try {
    const stroops = BigInt(stroopsStr);
    const negative = stroops < 0n;
    const magnitude = negative ? -stroops : stroops;
    const whole = magnitude / 10_000_000n;
    const fractionRaw = (magnitude % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
    const fraction = fractionRaw.length > 0 ? `.${fractionRaw}` : '';
    const sign = negative ? '-' : '';
    return `${sign}${whole.toString()}${fraction} ${code}`;
  } catch {
    return '—';
  }
}

/**
 * Top-N users by pending on-chain payout obligation (ADR 015 / 016).
 * Rendered on /admin/treasury under the LOOP-asset liabilities block
 * — answers "who's owed the most USDLOOP right now?" before ops tops
 * up an operator reserve.
 *
 * Self-hiding on empty (no in-flight payouts) and on fetch error so
 * the page above still renders the authoritative liability totals
 * even if this leaderboard is temporarily unavailable.
 */
export function TopUsersByPendingPayoutCard(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-top-users-by-pending-payout', DEFAULT_LIMIT],
    queryFn: () => getTopUsersByPendingPayout({ limit: DEFAULT_LIMIT }),
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
        Failed to load top-users-by-pending-payout.
      </p>
    );
  }

  if (query.data.entries.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No in-flight payouts right now — nothing to fund.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['User', 'Asset', 'Outstanding', 'Payouts'].map((h) => (
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
          {query.data.entries.map((row: TopUserByPendingPayoutEntry) => (
            <tr key={`${row.userId}-${row.assetCode}`}>
              <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                <Link
                  to={`/admin/users/${row.userId}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  aria-label={`Open user detail for ${row.email}`}
                >
                  {row.email}
                </Link>
              </td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{row.assetCode}</td>
              <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-white">
                {fmtStroops(row.totalStroops, row.assetCode)}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                <Link
                  to={`/admin/payouts?assetCode=${encodeURIComponent(row.assetCode)}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                  aria-label={`Review in-flight ${row.assetCode} payouts`}
                >
                  {row.payoutCount.toLocaleString(ADMIN_LOCALE)}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
