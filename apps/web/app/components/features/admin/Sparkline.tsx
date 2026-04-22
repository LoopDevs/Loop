import { Spinner } from '~/components/ui/Spinner';

const WIDTH = 560;
const HEIGHT = 64;

/**
 * Builds an SVG polyline `points=` string from a numeric series. Y
 * scales to the max value in the window (or 1 when every value is
 * zero, so an all-zero chart is a straight baseline rather than a
 * divide-by-zero). X distributes evenly. Zero anchors to `HEIGHT-2`
 * so a quiet day sinks to the bottom instead of floating mid-chart.
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

export interface SparklineSeries {
  label: string;
  values: number[];
  /** Tailwind text-color utilities (e.g. 'text-blue-500/80'). */
  colorClass: string;
  /** Swatch background used in the legend. */
  swatchClass: string;
  /** Optional dash pattern — omitted draws a solid line. */
  dashArray?: string;
  strokeWidth?: number;
}

export interface SparklineProps {
  title: string;
  /** Secondary line under the title (e.g. totals). */
  subtitle: string;
  /** Required a11y label — read by screen readers in place of the svg. */
  ariaLabel: string;
  series: SparklineSeries[];
  isPending: boolean;
  isError: boolean;
  errorMessage: string;
}

/**
 * Shared sparkline primitive for admin dashboard time-series cards.
 * Consolidates the CashbackSparkline / OrdersSparkline implementations
 * so future cards (payouts-over-time, merchant volume) can wire one
 * new series object rather than copy-pasting the chrome.
 *
 * Deliberately stays dumb about fetching — the caller passes a
 * `series[]`, a loading/error pair, and copy. The caller's query
 * hook owns the keyed cache + staleTime and transforms the response
 * into the series shape.
 */
export function Sparkline(props: SparklineProps): React.JSX.Element {
  if (props.isPending) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="h-16 flex items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }

  if (props.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        {props.errorMessage}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{props.title}</div>
          <div className="text-sm text-gray-900 dark:text-white tabular-nums">{props.subtitle}</div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={props.ariaLabel}
        className="w-full h-16"
      >
        {props.series.map((s) => {
          const points = toPoints(s.values);
          if (points === '') return null;
          return (
            <polyline
              key={s.label}
              points={points}
              fill="none"
              stroke="currentColor"
              strokeWidth={s.strokeWidth ?? 1.5}
              strokeDasharray={s.dashArray}
              className={s.colorClass}
            />
          );
        })}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
        {props.series.map((s) => (
          <span key={s.label}>
            <span className={`inline-block w-2 h-2 rounded-sm mr-1 ${s.swatchClass}`} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
