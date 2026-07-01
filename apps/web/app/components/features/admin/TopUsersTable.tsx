import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatMinorCurrency } from '@loop/shared';
import { getTopUsers, type TopUserRow } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

const WINDOWS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
] as const;
const DEFAULT_WINDOW_DAYS = 30;
const LIMIT = 20;

/**
 * F-WEBADMIN-09 (2026-06-30 cold audit): delegates to the canonical
 * bigint-exact shared formatter (CF-23) instead of `Number(minor) /
 * 100`. Rows here are always positive cashback sums, and
 * formatMinorCurrency already omits any sign for a positive amount
 * (only negatives get a `-` prefix), matching the prior
 * `signDisplay: 'never'` behaviour.
 */
export function fmtPositiveMinor(minor: string, currency: string): string {
  return formatMinorCurrency(minor, currency, { locale: ADMIN_LOCALE });
}

/**
 * Rolling 30-day top cashback earners. Section on /admin/users
 * alongside the paginated directory — gives ops a "who's our biggest
 * earner?" and concentration-risk view without leaving the page.
 * Each row links to the user detail drill-down.
 */
export function TopUsersTable(): React.JSX.Element {
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const query = useQuery({
    queryKey: ['admin-top-users', windowDays, LIMIT],
    // `since` is computed inside queryFn — not at render — so every
    // (re)fetch uses a fresh rolling window. A render-time value isn't
    // part of the queryKey, so it would pin the window to whenever the
    // component last rendered and serve an ever-staler slice on
    // long-lived admin pages (comprehensive-audit 2026-06-11, P10).
    queryFn: () => {
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      return getTopUsers({ since, limit: LIMIT });
    },
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const toggle = (
    <nav className="flex gap-1" aria-label="Top-users window">
      {WINDOWS.map((w) => (
        <button
          key={w.days}
          type="button"
          onClick={() => setWindowDays(w.days)}
          aria-pressed={windowDays === w.days}
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            windowDays === w.days
              ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900'
              : 'border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300'
          }`}
        >
          {w.label}
        </button>
      ))}
    </nav>
  );

  if (query.isPending) {
    return (
      <div className="space-y-3">
        {toggle}
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-3">
        {toggle}
        <p className="py-4 text-sm text-red-600 dark:text-red-400">Failed to load top users.</p>
      </div>
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <div className="space-y-3">
        {toggle}
        <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
          No cashback activity in the last {windowDays} days.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toggle}
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
                  {r.count.toLocaleString(ADMIN_LOCALE)}
                </td>
                <td className="px-3 py-2 tabular-nums font-medium text-gray-900 dark:text-white">
                  {fmtPositiveMinor(r.amountMinor, r.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
