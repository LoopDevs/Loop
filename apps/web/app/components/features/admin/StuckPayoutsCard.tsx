import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getStuckPayouts, type StuckPayoutRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * Returns the highest age from a set of stuck payout rows. Zero
 * when the list is empty so the caller can treat 0 as "nothing
 * stuck".
 */
export function maxAgeMinutes(rows: StuckPayoutRow[]): number {
  let max = 0;
  for (const r of rows) {
    if (r.ageMinutes > max) max = r.ageMinutes;
  }
  return max;
}

/**
 * Stuck-payouts card for the /admin landing, alongside
 * `StuckOrdersCard`. Same shape + poll cadence so ops reads both
 * signals in one glance: orders stuck in CTX procurement vs payouts
 * stuck in Stellar submission.
 *
 * Clicks through to `/admin/stuck-orders` — that page renders both
 * tables so the click-target stays a single URL regardless of which
 * backlog the operator wanted to drill into.
 */
export function StuckPayoutsCard(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-stuck-payouts'],
    queryFn: getStuckPayouts,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="h-5 w-20 animate-pulse bg-gray-100 dark:bg-gray-800 rounded" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Stuck payouts</div>
        <div className="mt-1 text-sm text-red-600 dark:text-red-400">—</div>
      </div>
    );
  }

  const count = query.data.rows.length;
  const age = maxAgeMinutes(query.data.rows);

  return (
    <Link
      to="/admin/stuck-orders"
      className={`rounded-xl border p-4 ${
        count > 0
          ? 'border-orange-200 bg-orange-50 hover:border-orange-400 dark:border-orange-900/60 dark:bg-orange-900/20 dark:hover:border-orange-700'
          : 'border-gray-200 bg-white hover:border-gray-400 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-600'
      }`}
    >
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Stuck payouts</div>
      <div
        className={`mt-1 text-base font-semibold tabular-nums ${
          count > 0 ? 'text-orange-700 dark:text-orange-300' : 'text-gray-900 dark:text-white'
        }`}
      >
        {count}
      </div>
      {count > 0 ? (
        <div className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-400">
          oldest {age} min · SLO {query.data.thresholdMinutes} min
        </div>
      ) : (
        <div className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-400">
          all within SLO ({query.data.thresholdMinutes} min)
        </div>
      )}
    </Link>
  );
}
