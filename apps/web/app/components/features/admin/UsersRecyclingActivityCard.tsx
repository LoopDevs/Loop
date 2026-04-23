import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatMinorCurrency } from '@loop/shared';
import { getAdminUsersRecyclingActivity, type UserRecyclingActivityRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * `/admin/treasury` — "who's recycling right now?" leaderboard (#611).
 *
 * Ranks users by most-recent `loop_asset` order over the last 90
 * days. Complements the other user-axis leaderboards:
 *   - `/top-users`                 — by lifetime cashback earned
 *   - `/top-by-pending-payout`     — by on-chain backlog
 *   - this card                    — by recent recycling
 *
 * Each row deep-links to `/admin/users/:userId` so the operator can
 * drill into the user's full history with one click — consistent
 * with the other user-facing leaderboards on the treasury page.
 *
 * Self-hides on error; renders the explicit "no recycling activity
 * yet" copy on empty so ops distinguishes "nobody's recycling" from
 * "component crashed" at a glance.
 */
export function UsersRecyclingActivityCard(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-users-recycling-activity'],
    queryFn: () => getAdminUsersRecyclingActivity({ limit: 25 }),
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

  if (query.isError) return null;

  const rows = query.data.rows;
  if (rows.length === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No users have recycled cashback in the last 90 days yet — this leaderboard lights up once
        LOOP-asset paid orders start landing.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800 text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900/50">
          <tr>
            {['User', 'Orders', 'Spent', 'Last recycled'].map((h) => (
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
          {rows.map((r) => (
            <RecyclingRow key={r.userId} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecyclingRow({ row }: { row: UserRecyclingActivityRow }): React.JSX.Element {
  let chargeDisplay: string;
  try {
    chargeDisplay = formatMinorCurrency(BigInt(row.recycledChargeMinor), row.currency);
  } catch {
    // Malformed bigint from the server — render em-dash rather
    // than tear down the whole row on a single bad field.
    chargeDisplay = '—';
  }
  const when = formatRelative(row.lastRecycledAt);

  return (
    <tr>
      <td className="px-3 py-2">
        <Link
          to={`/admin/users/${encodeURIComponent(row.userId)}`}
          className="text-blue-600 hover:underline dark:text-blue-400"
          aria-label={`Drill into ${row.email}`}
        >
          {row.email}
        </Link>
      </td>
      <td className="px-3 py-2 tabular-nums text-gray-900 dark:text-white">
        {row.recycledOrderCount.toLocaleString(ADMIN_LOCALE)}
      </td>
      <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-300">{chargeDisplay}</td>
      <td
        className="px-3 py-2 tabular-nums text-gray-500 dark:text-gray-400"
        title={row.lastRecycledAt}
      >
        {when}
      </td>
    </tr>
  );
}

/**
 * Compact relative-time formatter: "5m ago" / "2h ago" / "3d ago" /
 * date for anything past a week. Avoids pulling Intl.RelativeTimeFormat
 * for what's effectively a 4-bucket display.
 */
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  // A2-1521: admin view — use ADMIN_LOCALE so the date format
  // matches the numeric formatters in the same table (`42,000`
  // style). Prior `undefined` read the operator's browser locale
  // and mixed "23 Apr" (GB) with "Apr 23" (US) in one screen.
  return new Date(iso).toLocaleDateString(ADMIN_LOCALE, {
    month: 'short',
    day: 'numeric',
  });
}
