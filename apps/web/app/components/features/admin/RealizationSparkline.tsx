import { useQuery } from '@tanstack/react-query';
import { recycledBps } from '@loop/shared';
import { getCashbackRealizationDaily, type CashbackRealizationDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Sparkline } from './Sparkline';

const WINDOW_DAYS = 30;

/**
 * Collapse a per-(day, currency) row list into a per-day sequence
 * of fleet-wide `recycledBps` values. For each day:
 *
 *   recycledBps(day) = SUM(spent) / SUM(earned) × 10 000
 *
 * computed across all currencies so the sparkline reads as the fleet
 * flywheel's daily signal. Days with zero earned emit 0 — the chart
 * primitive handles the rendering.
 *
 * A2-810: per-day bps is now computed via the shared
 * `recycledBps` helper from `@loop/shared/cashback-realization` —
 * the same function `/api/admin/cashback-realization` and the
 * daily CSV exporter use, so the sparkline can never round
 * differently from the headline card on the same data.
 *
 * Exported for unit testing — the cross-currency aggregation step
 * is not the shape the backend emits (per-currency rows), so the
 * collapse remains worth an explicit contract test.
 */
export function toDailyBps(rows: readonly CashbackRealizationDay[]): number[] {
  const byDay = new Map<string, { earned: bigint; spent: bigint }>();
  for (const r of rows) {
    const prev = byDay.get(r.day) ?? { earned: 0n, spent: 0n };
    let earned: bigint;
    let spent: bigint;
    try {
      earned = BigInt(r.earnedMinor);
      spent = BigInt(r.spentMinor);
    } catch {
      continue;
    }
    byDay.set(r.day, {
      earned: prev.earned + earned,
      spent: prev.spent + spent,
    });
  }
  const days = Array.from(byDay.keys()).sort();
  return days.map((d) => {
    const { earned, spent } = byDay.get(d)!;
    return recycledBps(earned, spent);
  });
}

/**
 * 30-day fleet realization-rate sparkline on /admin landing.
 * Companion to the single-point realization card (#730) — that card
 * shows "are we recycling now?", this shows "is that rate trending
 * up or down?". Ops notices a flywheel regression early even when
 * the current bps is still within tolerance.
 *
 * Thin wrapper around the existing `<Sparkline>` primitive so it
 * visually matches the cashback + payouts + orders sparklines
 * already on the page.
 */
export function RealizationSparkline(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-cashback-realization-daily', WINDOW_DAYS],
    queryFn: () => getCashbackRealizationDaily(WINDOW_DAYS),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  const values = query.data !== undefined ? toDailyBps(query.data.rows) : [];
  const latest = values.length > 0 ? values[values.length - 1]! : 0;
  const latestPct = (latest / 100).toFixed(1);

  return (
    <Sparkline
      title={`Realization rate (${WINDOW_DAYS}d)`}
      subtitle={`${latestPct}% today`}
      ariaLabel={`Fleet cashback realization rate over the last ${WINDOW_DAYS} days, ${latestPct}% today`}
      isPending={query.isPending}
      isError={query.isError}
      errorMessage="Failed to load realization trend."
      series={[
        {
          label: 'Recycled bps',
          values,
          colorClass: 'text-purple-500/70 dark:text-purple-400/70',
          swatchClass: 'bg-purple-500/70',
        },
      ]}
    />
  );
}
