import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ApiException, formatMinorCurrency } from '@loop/shared';
import { getAdminMerchantTopEarners, type MerchantTopEarnerRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Admin `/admin/merchants/:merchantId` — top cashback earners at
 * this merchant (#655). Inverse axis of the per-user
 * `UserCashbackByMerchantTable`:
 *   - per-user view: "which merchants did Alice earn at?"
 *   - per-merchant view (this): "who earned the most at Amazon?"
 *
 * BD / support drives outreach off this card. A whale's email is
 * a link to the user drill so ops can pivot between user-level
 * and merchant-level views without re-searching.
 *
 * Fixed 30d / top 10 — the card is a quick scan, not a full
 * leaderboard. A bigger-limit export can hang off a future CSV
 * sibling if finance needs it.
 *
 * Zero-earners merchants render a neutral line (not silent-hide)
 * so the card visibly confirms "no whales here" rather than
 * looking like it crashed. 404 silent-null (evicted merchant).
 */
const WINDOW_DAYS = 30;
const LIMIT = 10;

export function MerchantTopEarnersCard({
  merchantId,
}: {
  merchantId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchant-top-earners', merchantId, WINDOW_DAYS, LIMIT],
    queryFn: () => getAdminMerchantTopEarners(merchantId, { days: WINDOW_DAYS, limit: LIMIT }),
    enabled: merchantId.length > 0,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  return (
    <section className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          Top earners (last {WINDOW_DAYS} days)
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Users ranked by cashback earned at this merchant — the inverse of the cashback-by-
          merchant table on the user drill. A whale here is a target for BD outreach, or a
          high-impact support ticket.
        </p>
      </header>
      <div className="p-6">
        <Body query={query} />
      </div>
    </section>
  );
}

function Body({
  query,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAdminMerchantTopEarners>>>>;
}): React.JSX.Element | null {
  if (query.isPending) return <Spinner />;

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return <p className="text-sm text-red-600 dark:text-red-400">Failed to load top earners.</p>;
  }

  const snapshot = query.data;

  if (snapshot.rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No earners at this merchant in the last {WINDOW_DAYS} days.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">Currency</th>
            <th className="px-3 py-2">Orders</th>
            <th className="px-3 py-2">Cashback</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-900">
          {snapshot.rows.map((row, idx) => (
            <TopEarnerRow key={`${row.userId}-${row.currency}`} row={row} rank={idx + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopEarnerRow({
  row,
  rank,
}: {
  row: MerchantTopEarnerRow;
  rank: number;
}): React.JSX.Element {
  let cashback: bigint;
  try {
    cashback = BigInt(row.cashbackMinor);
  } catch {
    // Malformed bigint — skip the currency formatting but keep
    // the rest of the row so ops can still see which user the
    // broken value belonged to.
    return (
      <tr>
        <td className="px-3 py-2 text-xs text-gray-400">{rank}</td>
        <td className="px-3 py-2">
          <Link
            to={`/admin/users/${encodeURIComponent(row.userId)}`}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {row.email}
          </Link>
        </td>
        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">
          {row.currency}
        </td>
        <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
          {row.orderCount.toLocaleString('en-US')}
        </td>
        <td className="px-3 py-2 text-gray-400">—</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="px-3 py-2 tabular-nums text-xs text-gray-500 dark:text-gray-400">{rank}</td>
      <td className="px-3 py-2">
        <Link
          to={`/admin/users/${encodeURIComponent(row.userId)}`}
          className="text-blue-600 hover:underline dark:text-blue-400"
          aria-label={`Open drill-down for ${row.email}`}
        >
          {row.email}
        </Link>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">
        {row.currency}
      </td>
      <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">
        {row.orderCount.toLocaleString('en-US')}
      </td>
      <td className="px-3 py-2 tabular-nums font-semibold text-green-700 dark:text-green-300">
        {formatMinorCurrency(cashback, row.currency)}
      </td>
    </tr>
  );
}
