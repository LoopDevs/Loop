import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getAdminCashbackMonthly,
  type AdminCashbackMonthlyEntry,
  type AdminCashbackMonthlyResponse,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import {
  computeMax,
  barWidthPct,
  monthLabel,
  formatMinor,
} from '~/components/features/cashback/MonthlyCashbackChart';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Fleet-wide monthly cashback bar chart for `/admin/treasury` (#592).
 *
 * Admin mirror of the user-facing `MonthlyCashbackChart` on
 * `/settings/cashback`. Reuses the same CSS-only bar-rendering
 * primitives (`computeMax` / `barWidthPct` / `monthLabel` /
 * `formatMinor`) so the two charts stay visually identical and
 * share one set of bigint-safe math.
 *
 * Differences from the user-side chart:
 *   - Fetches `/api/admin/cashback-monthly` (no user filter).
 *   - Surfaces an explicit "No cashback emitted yet" empty-state
 *     instead of silent-hiding: an operator looking at this card
 *     should see "we haven't started" rather than think the chart
 *     crashed.
 *   - Surfaces an explicit error line — this is a dashboard, not a
 *     user-facing cherry on top, and a silent failure masks
 *     infrastructure problems.
 *
 * 5-minute stale time matches the user side; the monthly aggregate
 * doesn't move faster than that in practice.
 */
export function AdminMonthlyCashbackChart(): React.JSX.Element {
  const query = useQuery({
    // A2-1160: single-string hyphenated key matches the rest of the
    // admin-side taxonomy (`admin-cashback-activity`,
    // `admin-treasury`, etc.); previously collided cosmetically with
    // `['me', 'cashback-monthly']` from MonthlyCashbackChart.
    queryKey: ['admin-cashback-monthly'],
    queryFn: getAdminCashbackMonthly,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  const byCurrency = useMemo(() => groupByCurrency(query.data), [query.data]);

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
        Failed to load monthly cashback.
      </p>
    );
  }

  if (byCurrency.size === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No cashback emitted in the last 12 months yet — the flywheel needs first-order volume before
        the monthly trend is meaningful.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {Array.from(byCurrency.entries()).map(([currency, entries]) => (
        <CurrencyBars key={currency} currency={currency} entries={entries} />
      ))}
    </div>
  );
}

function groupByCurrency(
  response: AdminCashbackMonthlyResponse | undefined,
): Map<string, AdminCashbackMonthlyEntry[]> {
  const map = new Map<string, AdminCashbackMonthlyEntry[]>();
  if (response === undefined) return map;
  for (const entry of response.entries) {
    const bucket = map.get(entry.currency);
    if (bucket === undefined) map.set(entry.currency, [entry]);
    else bucket.push(entry);
  }
  return map;
}

function CurrencyBars({
  currency,
  entries,
}: {
  currency: string;
  entries: AdminCashbackMonthlyEntry[];
}): React.JSX.Element {
  const maxMinor = useMemo(() => computeMax(entries), [entries]);
  return (
    <div>
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">{currency}</div>
      <ul role="list" className="space-y-1.5">
        {entries.map((e) => (
          <li
            key={`${e.month}-${e.currency}`}
            className="flex items-center gap-2 text-xs"
            aria-label={`${monthLabel(e.month)} ${formatMinor(e.cashbackMinor, e.currency)}`}
          >
            <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">
              {monthLabel(e.month)}
            </span>
            <span
              className="h-3 rounded bg-green-500/80 dark:bg-green-400/70"
              style={{
                width: `${barWidthPct(e.cashbackMinor, maxMinor)}%`,
                minWidth: barWidthPct(e.cashbackMinor, maxMinor) > 0 ? '2px' : '0px',
              }}
              aria-hidden="true"
            />
            <span className="tabular-nums text-gray-700 dark:text-gray-300">
              {formatMinor(e.cashbackMinor, e.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
