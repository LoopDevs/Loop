import { useQuery } from '@tanstack/react-query';
import { getOrdersActivity } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

const WIDTH = 560;
const HEIGHT = 64;
const WINDOW_DAYS = 14;

/**
 * Builds an SVG polyline from a numeric series. Y scales to the max
 * value in the window; x distributes evenly. Zero anchors to the
 * chart baseline (HEIGHT-2) so a quiet day sinks to the bottom
 * instead of floating at the middle.
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
 * Orders-activity sparkline — a 14-day polyline of created vs
 * fulfilled counts for the /admin/orders page header. Pulls from
 * the ADR 010 endpoint (`/api/admin/orders/activity`) which returns
 * zero-filled days, so the chart stays stable across weekends /
 * quiet periods.
 */
export function OrdersSparkline(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-orders-activity', WINDOW_DAYS],
    queryFn: () => getOrdersActivity(WINDOW_DAYS),
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
        Failed to load orders activity.
      </div>
    );
  }

  const createdSeries = query.data.days.map((d) => d.created);
  const fulfilledSeries = query.data.days.map((d) => d.fulfilled);
  const totalCreated = createdSeries.reduce((a, b) => a + b, 0);
  const totalFulfilled = fulfilledSeries.reduce((a, b) => a + b, 0);

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Orders activity ({WINDOW_DAYS}d)
          </div>
          <div className="text-sm text-gray-900 dark:text-white tabular-nums">
            {totalCreated.toLocaleString('en-US')} created ·{' '}
            {totalFulfilled.toLocaleString('en-US')} fulfilled
          </div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Orders activity over the last ${WINDOW_DAYS} days: ${totalCreated} created, ${totalFulfilled} fulfilled`}
        className="w-full h-16"
      >
        <polyline
          points={toPoints(createdSeries)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-blue-500/80 dark:text-blue-400/80"
        />
        <polyline
          points={toPoints(fulfilledSeries)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-green-500/70 dark:text-green-400/70"
        />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-blue-500/80 mr-1" />
          Created
        </span>
        <span>
          <span className="inline-block w-2 h-2 rounded-sm bg-green-500/70 mr-1" />
          Fulfilled
        </span>
      </div>
    </div>
  );
}
