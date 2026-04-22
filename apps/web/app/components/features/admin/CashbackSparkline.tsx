import { useQuery } from '@tanstack/react-query';
import { getCashbackActivity, type CashbackActivityDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

const WIDTH = 560;
const HEIGHT = 64;
const WINDOW_DAYS = 30;

/**
 * Sums per-currency minor amounts for a single day using BigInt so
 * large ledgers don't lose precision. Returns a plain number because
 * the sparkline only needs visual magnitude, not accounting-accurate
 * totals — the exact-amount table on the Treasury page is for that.
 */
function dayTotalMinor(d: CashbackActivityDay): number {
  let sum = 0n;
  for (const row of d.byCurrency) {
    try {
      sum += BigInt(row.amountMinor);
    } catch {
      /* bad row — skip */
    }
  }
  // Number(BigInt) is lossy past 2^53, but sparkline only needs a
  // coarse magnitude — the exact amount shown in the tooltip uses
  // the bigint-preserving string from the backend.
  return Number(sum);
}

/**
 * Builds an SVG polyline from the series. The y-axis scales to the
 * max value in the window so a slow week still shows shape; the
 * baseline anchors to 0 so a zero day sits at the bottom of the chart
 * not the middle.
 */
export function toPoints(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? WIDTH / (values.length - 1) : WIDTH;
  return values
    .map((v, i) => {
      const x = i * stepX;
      const y = HEIGHT - (v / max) * (HEIGHT - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * Compact cashback-over-time card. Pulls the cashback-activity
 * endpoint for a 30-day window; renders a pure-SVG polyline (no chart
 * library). Zero days render at the baseline so the line visually
 * "drops" on an inactive day.
 */
export function CashbackSparkline(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-cashback-activity', WINDOW_DAYS],
    queryFn: () => getCashbackActivity(WINDOW_DAYS),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="h-16 animate-pulse bg-gray-100 dark:bg-gray-800 rounded" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        Failed to load cashback activity.
      </div>
    );
  }

  const rows = query.data.rows;
  const counts = rows.map((r) => r.count);
  const totals = rows.map(dayTotalMinor);
  const totalCount = counts.reduce((a, b) => a + b, 0);
  const countPath = toPoints(counts);
  const amountPath = toPoints(totals);

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Cashback activity ({WINDOW_DAYS}d)
          </div>
          <div className="text-sm text-gray-900 dark:text-white tabular-nums">
            {totalCount.toLocaleString('en-US')} credits
          </div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cashback accrual over the last ${WINDOW_DAYS} days, ${totalCount} credit-transactions total`}
        className="w-full h-16"
      >
        {amountPath !== '' ? (
          <polyline
            points={amountPath}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-green-500/70 dark:text-green-400/70"
          />
        ) : null}
        {countPath !== '' ? (
          <polyline
            points={countPath}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            className="text-blue-500/50 dark:text-blue-400/50"
          />
        ) : null}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-green-500/70 mr-1" />
          Amount (all currencies)
        </span>
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-blue-500/50 mr-1" />
          Count
        </span>
      </div>
    </div>
  );
}
