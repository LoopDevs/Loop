import { useQuery } from '@tanstack/react-query';
import { getPayoutsActivity, type PayoutsActivityDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Sparkline } from './Sparkline';
import { ADMIN_LOCALE } from '~/utils/locale';

const WINDOW_DAYS = 30;

/**
 * Sums per-asset stroops for one day using BigInt so large payout
 * days don't lose precision during aggregation. Returned as a plain
 * number because the sparkline only needs visual magnitude — the
 * exact-stroop reconciliation lives on the treasury-reconciliation
 * chart above.
 *
 * `Number(BigInt)` is lossy past 2^53 stroops (~9×10^15 — ten million
 * USDLOOP), but sparkline height only needs a rough signal at that
 * scale. The backend preserves the bigint string for anywhere that
 * needs exact value.
 */
export function dayTotalStroops(d: PayoutsActivityDay): number {
  let sum = 0n;
  for (const row of d.byAsset) {
    try {
      sum += BigInt(row.stroops);
    } catch {
      /* bad row — skip */
    }
  }
  return Number(sum);
}

/**
 * 30-day confirmed-payout sparkline on /admin/treasury (#637).
 * Settlement-side counterpart to `CashbackSparkline` — same visual
 * primitive, different data source. Cashback tracks liability
 * creation per day; payouts tracks settlement per day.
 *
 * Blue amount line + orange count line so the two lines read
 * distinctly from the cashback card's green + blue — visually
 * marks that this is the outflow side of the ledger, not the
 * inflow side.
 */
export function PayoutsSparkline(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-payouts-activity', WINDOW_DAYS],
    queryFn: () => getPayoutsActivity(WINDOW_DAYS),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const rows = query.data?.rows ?? [];
  const counts = rows.map((r) => r.count);
  const totals = rows.map(dayTotalStroops);
  const totalCount = counts.reduce((a, b) => a + b, 0);

  return (
    <Sparkline
      title={`Payouts activity (${WINDOW_DAYS}d)`}
      subtitle={`${totalCount.toLocaleString(ADMIN_LOCALE)} confirmed`}
      ariaLabel={`Confirmed on-chain payouts over the last ${WINDOW_DAYS} days, ${totalCount} transactions total`}
      isPending={query.isPending}
      isError={query.isError}
      errorMessage="Failed to load payouts activity."
      series={[
        {
          label: 'Stroops (all assets)',
          values: totals,
          colorClass: 'text-blue-500/70 dark:text-blue-400/70',
          swatchClass: 'bg-blue-500/70',
        },
        {
          label: 'Count',
          values: counts,
          colorClass: 'text-orange-500/60 dark:text-orange-400/60',
          swatchClass: 'bg-orange-500/60',
          dashArray: '3 3',
          strokeWidth: 1,
        },
      ]}
    />
  );
}
