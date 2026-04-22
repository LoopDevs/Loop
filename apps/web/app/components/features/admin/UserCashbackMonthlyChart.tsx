import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import { getAdminUserCashbackMonthly, type AdminUserCashbackMonthlyEntry } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import {
  computeMax,
  barWidthPct,
  monthLabel,
  formatMinor,
} from '~/components/features/cashback/MonthlyCashbackChart';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Per-user 12-month cashback trend chart (#633) — mounted on
 * `/admin/users/:userId`. User-scoped sibling of the fleet
 * `AdminMonthlyCashbackChart` on `/admin/treasury`. Same bar-
 * rendering primitives (`computeMax` / `barWidthPct` /
 * `monthLabel` / `formatMinor`) so the two charts stay visually
 * identical.
 *
 * Answers "is this user's cashback earning trending up?" — the
 * time-series companion to the user's scalar cashback-summary
 * chip. A new user with no cashback yet renders the neutral
 * empty-state line; 404 (user deleted between list and drill) is
 * silent-null so the rest of the page renders.
 */
export function UserCashbackMonthlyChart({ userId }: { userId: string }): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-user-cashback-monthly', userId],
    queryFn: () => getAdminUserCashbackMonthly(userId),
    enabled: userId.length > 0,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  const byCurrency = useMemo(() => groupByCurrency(query.data?.entries), [query.data?.entries]);

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    if (query.error instanceof ApiException && query.error.status === 404) {
      return null;
    }
    return (
      <p className="py-4 text-sm text-red-600 dark:text-red-400">
        Failed to load monthly cashback.
      </p>
    );
  }

  if (byCurrency.size === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No cashback earned in the last 12 months yet.
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
  entries: AdminUserCashbackMonthlyEntry[] | undefined,
): Map<string, AdminUserCashbackMonthlyEntry[]> {
  const map = new Map<string, AdminUserCashbackMonthlyEntry[]>();
  if (entries === undefined) return map;
  for (const entry of entries) {
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
  entries: AdminUserCashbackMonthlyEntry[];
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
