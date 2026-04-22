import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import {
  getAdminMerchantCashbackMonthly,
  type AdminMerchantCashbackMonthlyEntry,
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
 * Per-merchant 12-month cashback-emission trend (#635). Mounts on
 * `/admin/merchants/:merchantId`. Merchant-scoped sibling of the
 * fleet `AdminMonthlyCashbackChart` and the per-user
 * `UserCashbackMonthlyChart` (#634). Same bar-rendering
 * primitives so all three render identically.
 *
 * Answers "is cashback emission at this merchant trending up or
 * down?" — the time-series companion to the scalar
 * `MerchantCashbackPaidCard` (#626). Same pinned per-order data,
 * different axis.
 *
 * Zero-volume merchants render the neutral empty-state line;
 * 404 silent-null (catalog evicted between list and drill).
 */
export function MerchantCashbackMonthlyChart({
  merchantId,
}: {
  merchantId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['admin-merchant-cashback-monthly', merchantId],
    queryFn: () => getAdminMerchantCashbackMonthly(merchantId),
    enabled: merchantId.length > 0,
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
        No cashback minted on fulfilled orders at this merchant in the last 12 months yet.
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
  entries: AdminMerchantCashbackMonthlyEntry[] | undefined,
): Map<string, AdminMerchantCashbackMonthlyEntry[]> {
  const map = new Map<string, AdminMerchantCashbackMonthlyEntry[]>();
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
  entries: AdminMerchantCashbackMonthlyEntry[];
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
