import { useQuery } from '@tanstack/react-query';
import {
  getAdminPaymentMethodActivity,
  type AdminPaymentMethod,
  type PaymentMethodActivityDay,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * CSS-only stacked-bar chart — one bar per UTC day over the last 30
 * days, split into four segments per rail. Consumes
 * /api/admin/orders/payment-method-activity (#594).
 *
 * Positioned below `PaymentMethodShareCard` on `/admin/treasury`: the
 * share card is the single-snapshot, this is the trend. Together
 * they surface the ADR-015 flywheel signal — rising `loop_asset`
 * share over time is the indicator cashback is being recycled.
 *
 * Visual contract:
 *  - Y-axis: day (oldest → newest, top → bottom).
 *  - X-axis: fulfilled-order count, proportional within each row.
 *  - Green (`loop_asset`) is emphasised at the leading edge so the
 *    eye naturally scans that segment — the flywheel rail.
 *  - Zero-order days render as a single grey pill so the layout
 *    stays stable and an operator can see "no orders on this day".
 */
const METHOD_ORDER: readonly AdminPaymentMethod[] = [
  'loop_asset',
  'credit',
  'usdc',
  'xlm',
] as const;

/**
 * Per-rail classes. `loop_asset` gets green for the same reason as
 * the share card — a rising green segment is the flywheel signal.
 */
const METHOD_SEGMENT_CLASS: Record<AdminPaymentMethod, string> = {
  loop_asset: 'bg-green-500/80 dark:bg-green-400/70',
  credit: 'bg-blue-500/70 dark:bg-blue-400/60',
  usdc: 'bg-purple-500/70 dark:bg-purple-400/60',
  xlm: 'bg-gray-500/60 dark:bg-gray-400/50',
};

const METHOD_LABELS: Record<AdminPaymentMethod, string> = {
  loop_asset: 'LOOP asset',
  credit: 'Credit',
  usdc: 'USDC',
  xlm: 'XLM',
};

export function PaymentMethodActivityChart(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-payment-method-activity', 30],
    queryFn: () => getAdminPaymentMethodActivity({ days: 30 }),
    retry: shouldRetry,
    staleTime: 60_000,
  });

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
        Failed to load payment-method activity.
      </p>
    );
  }

  const snapshot = query.data;
  const totalAcrossWindow = sumTotal(snapshot.days);
  if (totalAcrossWindow === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No fulfilled orders in the last {snapshot.windowDays} days — the flywheel trend needs volume
        before it's readable.
      </p>
    );
  }

  return (
    <div>
      <Legend />
      <ul role="list" className="mt-3 space-y-1">
        {snapshot.days.map((d) => (
          <DayRow key={d.day} day={d} />
        ))}
      </ul>
    </div>
  );
}

function Legend(): React.JSX.Element {
  return (
    <ul
      role="list"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400"
      aria-label="Payment-method legend"
    >
      {METHOD_ORDER.map((m) => (
        <li key={m} className="inline-flex items-center gap-1.5">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-sm ${METHOD_SEGMENT_CLASS[m]}`}
            aria-hidden="true"
          />
          <span>{METHOD_LABELS[m]}</span>
        </li>
      ))}
    </ul>
  );
}

function DayRow({ day }: { day: PaymentMethodActivityDay }): React.JSX.Element {
  const total = METHOD_ORDER.reduce((acc, m) => acc + day.byMethod[m], 0);
  const label = shortDay(day.day);

  return (
    <li
      className="flex items-center gap-2 text-xs"
      aria-label={`${label}: ${total} fulfilled ${total === 1 ? 'order' : 'orders'}`}
    >
      <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">{label}</span>
      <span className="flex h-3 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
        {total === 0 ? null : (
          <>
            {METHOD_ORDER.map((m) => {
              const count = day.byMethod[m];
              if (count === 0) return null;
              const widthPct = (count / total) * 100;
              return (
                <span
                  key={m}
                  className={METHOD_SEGMENT_CLASS[m]}
                  style={{ width: `${widthPct}%` }}
                  aria-hidden="true"
                />
              );
            })}
          </>
        )}
      </span>
      <span className="shrink-0 w-10 tabular-nums text-right text-gray-700 dark:text-gray-300">
        {total}
      </span>
    </li>
  );
}

/**
 * `"2026-04-22"` → `"Apr 22"`. Keeps the chart labels compact so a
 * 30-row list doesn't bloat horizontally. Defensive parse — returns
 * the raw string if the format doesn't match the expected shape.
 */
export function shortDay(ymd: string): string {
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  const [, m, d] = parts;
  if (m === undefined || d === undefined) return ymd;
  const mn = Number(m);
  if (!Number.isFinite(mn) || mn < 1 || mn > 12) return ymd;
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${names[mn - 1] ?? m} ${Number(d)}`;
}

function sumTotal(days: PaymentMethodActivityDay[]): number {
  let total = 0;
  for (const d of days) {
    for (const m of METHOD_ORDER) total += d.byMethod[m];
  }
  return total;
}
