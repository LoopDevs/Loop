import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getCashbackMonthly,
  type CashbackMonthlyEntry,
  type CashbackMonthlyResponse,
} from '~/services/user';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Monthly cashback bar chart for /settings/cashback. Reads the
 * 12-month aggregate endpoint from #576 and renders a compact
 * horizontal bar chart per home-currency.
 *
 * Multi-currency users see one chart per currency. Single-currency
 * users (the common case) see one. Self-hides when the user has
 * never earned cashback — the rest of the page's cards already cover
 * the "nothing yet" story.
 *
 * Deliberately CSS-only (no charting library). The values are already
 * shaped as (month, currency, amount) and the only axis is time;
 * a list of flex-children with a percent-of-max width renders
 * correctly at every viewport without a runtime measure. The trade
 * is "no axis labels" — acceptable because users care about
 * relative comparisons (this month vs. last), and each bar carries
 * its own month + amount label.
 */
export function MonthlyCashbackChart(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['me', 'cashback-monthly'],
    queryFn: getCashbackMonthly,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  const byCurrency = useMemo(() => groupByCurrency(query.data), [query.data]);

  if (query.isPending) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }

  // Silent fail — ledger/history cards above cover the "nothing to
  // show" story; no point splashing red over a chart that's meant to
  // be a visual cherry on top.
  if (query.isError) return null;

  if (byCurrency.size === 0) return null;

  return (
    <section
      aria-labelledby="monthly-cashback-heading"
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
    >
      <h2
        id="monthly-cashback-heading"
        className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
      >
        Last 12 months
      </h2>
      <div className="space-y-5 px-5 pb-5 pt-2">
        {Array.from(byCurrency.entries()).map(([currency, entries]) => (
          <CurrencyBars key={currency} currency={currency} entries={entries} />
        ))}
      </div>
    </section>
  );
}

/**
 * Groups backend entries by currency, preserving the server's
 * oldest-first order within each currency. Multi-currency users
 * have two or three entries per month; we want one chart each.
 */
function groupByCurrency(
  response: CashbackMonthlyResponse | undefined,
): Map<string, CashbackMonthlyEntry[]> {
  const map = new Map<string, CashbackMonthlyEntry[]>();
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
  entries: CashbackMonthlyEntry[];
}): React.JSX.Element {
  const maxMinor = useMemo(() => computeMax(entries), [entries]);

  return (
    <div>
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">{currency}</div>
      <ul role="list" className="space-y-1.5">
        {entries.map((e) => (
          <MonthBar key={`${e.month}-${e.currency}`} entry={e} maxMinor={maxMinor} />
        ))}
      </ul>
    </div>
  );
}

function MonthBar({
  entry,
  maxMinor,
}: {
  entry: CashbackMonthlyEntry;
  maxMinor: bigint;
}): React.JSX.Element {
  const widthPct = useMemo(() => barWidthPct(entry.cashbackMinor, maxMinor), [entry, maxMinor]);
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">
        {monthLabel(entry.month)}
      </span>
      <span
        className="h-3 rounded bg-green-500/80 dark:bg-green-400/70"
        style={{ width: `${widthPct}%`, minWidth: widthPct > 0 ? '2px' : '0px' }}
        aria-hidden="true"
      />
      <span className="tabular-nums text-gray-700 dark:text-gray-300">
        {formatMinor(entry.cashbackMinor, entry.currency)}
      </span>
    </li>
  );
}

/**
 * Largest minor-unit amount across all entries. BigInt because a
 * long-time user's annual totals can exceed Number.MAX_SAFE_INTEGER;
 * the bar-width ratio is computed with bigint arithmetic.
 */
export function computeMax(entries: CashbackMonthlyEntry[]): bigint {
  let max = 0n;
  for (const e of entries) {
    try {
      const v = BigInt(e.cashbackMinor);
      if (v > max) max = v;
    } catch {
      /* malformed row — skip */
    }
  }
  return max;
}

/**
 * Converts a (value, max) pair to a percentage width. Returns 0 when
 * max is 0 (nothing to compare against); otherwise returns the ratio
 * in the 0..100 range. BigInt arithmetic preserves precision; the
 * output is a plain `number` so React style merging works.
 */
export function barWidthPct(valueMinor: string, maxMinor: bigint): number {
  if (maxMinor === 0n) return 0;
  let v: bigint;
  try {
    v = BigInt(valueMinor);
  } catch {
    return 0;
  }
  // value / max * 100, safe across any bigint size.
  return Number((v * 10000n) / maxMinor) / 100;
}

/**
 * `"2026-04"` → `"Apr 26"`. Defensive parse — returns the raw string
 * if the input doesn't match the expected shape, rather than throwing
 * and tearing the chart down.
 */
export function monthLabel(ym: string): string {
  const parts = ym.split('-');
  if (parts.length !== 2) return ym;
  const [year, month] = parts;
  if (year === undefined || month === undefined) return ym;
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(m) || !Number.isFinite(y) || m < 1 || m > 12) return ym;
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
  const shortYear = String(y).slice(-2);
  return `${names[m - 1] ?? month} ${shortYear}`;
}

/**
 * Minor units → localised currency string with no decimals. The
 * chart is a summary view; pennies aren't load-bearing.
 */
export function formatMinor(minor: string, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(0)} ${currency}`;
  }
}
