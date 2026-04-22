import { useQuery } from '@tanstack/react-query';
import { getCashbackActivity, type CashbackActivityDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Sparkline } from './Sparkline';

const WINDOW_DAYS = 30;

/**
 * Sums per-currency minor amounts for a single day using BigInt so
 * large ledgers don't lose precision during aggregation. Returns a
 * plain number because the sparkline only needs visual magnitude —
 * the exact-amount table on the Treasury page is the accounting
 * source of truth.
 */
export function dayTotalMinor(d: CashbackActivityDay): number {
  let sum = 0n;
  for (const row of d.byCurrency) {
    try {
      sum += BigInt(row.amountMinor);
    } catch {
      /* bad row — skip */
    }
  }
  // Number(BigInt) is lossy past 2^53, but sparkline magnitude only
  // needs a rough signal. Amounts shown elsewhere use the
  // bigint-preserving string from the backend.
  return Number(sum);
}

/**
 * 30-day cashback-accrual chart on the admin dashboard. Thin wrapper
 * around the generic `<Sparkline>` primitive — owns the fetch + the
 * cashback-specific copy, delegates chrome.
 */
export function CashbackSparkline(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-cashback-activity', WINDOW_DAYS],
    queryFn: () => getCashbackActivity(WINDOW_DAYS),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const rows = query.data?.rows ?? [];
  const counts = rows.map((r) => r.count);
  const totals = rows.map(dayTotalMinor);
  const totalCount = counts.reduce((a, b) => a + b, 0);

  return (
    <Sparkline
      title={`Cashback activity (${WINDOW_DAYS}d)`}
      subtitle={`${totalCount.toLocaleString('en-US')} credits`}
      ariaLabel={`Cashback accrual over the last ${WINDOW_DAYS} days, ${totalCount} credit-transactions total`}
      isPending={query.isPending}
      isError={query.isError}
      errorMessage="Failed to load cashback activity."
      series={[
        {
          label: 'Amount (all currencies)',
          values: totals,
          colorClass: 'text-green-500/70 dark:text-green-400/70',
          swatchClass: 'bg-green-500/70',
        },
        {
          label: 'Count',
          values: counts,
          colorClass: 'text-blue-500/50 dark:text-blue-400/50',
          swatchClass: 'bg-blue-500/50',
          dashArray: '3 3',
          strokeWidth: 1,
        },
      ]}
    />
  );
}

// Re-export toPoints so the existing test module import still works.
export { toPoints } from './Sparkline';
