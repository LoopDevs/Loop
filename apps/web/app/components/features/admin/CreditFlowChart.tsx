import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTreasuryCreditFlow, type TreasuryCreditFlowDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { shortDay } from './PaymentMethodActivityChart';

/**
 * CSS-only per-day ledger-delta chart over the last N days for one
 * currency. Consumes `/api/admin/treasury/credit-flow`.
 *
 * Sits below the "Ledger movements" section on `/admin/treasury`:
 * the ledger table shows all-time by type; this shows the daily
 * delta so ops can answer "are we generating liability faster than
 * we settle it?" at a glance.
 *
 * Diverging bar — credited grows right, debited grows left. Net
 * is printed on the right; positive net (liability growing) is
 * amber-coded, negative (settling down) is blue, zero is muted.
 *
 * Bars are scaled against `max(credited, debited)` across the
 * window so one big day doesn't flatten the others to invisibility.
 */
const CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
type Cur = (typeof CURRENCIES)[number];

const SYMBOL: Record<Cur, string> = { USD: '$', GBP: '£', EUR: '€' };

function fmtMinor(minor: string, currency: Cur): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const sign = negative ? '-' : '';
  return `${sign}${SYMBOL[currency]}${Number(whole).toLocaleString('en-US')}.${fraction}`;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function CreditFlowChart(): React.JSX.Element {
  const [currency, setCurrency] = useState<Cur>('USD');

  const query = useQuery({
    queryKey: ['admin-treasury-credit-flow', currency, 30],
    queryFn: () => getTreasuryCreditFlow({ days: 30, currency }),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  return (
    <div>
      <CurrencyPicker value={currency} onChange={setCurrency} />
      <Legend />
      <div className="mt-3">
        {query.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-4 text-sm text-red-600 dark:text-red-400">
            Failed to load credit-flow activity.
          </p>
        ) : (
          <Chart days={query.data.days} currency={currency} />
        )}
      </div>
    </div>
  );
}

function CurrencyPicker({
  value,
  onChange,
}: {
  value: Cur;
  onChange: (v: Cur) => void;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Credit-flow currency filter"
      className="inline-flex rounded-md border border-gray-200 dark:border-gray-800 overflow-hidden text-xs"
    >
      {CURRENCIES.map((c) => {
        const active = c === value;
        return (
          <button
            key={c}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => {
              onChange(c);
            }}
            className={`px-3 py-1 font-medium tabular-nums ${
              active
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function Legend(): React.JSX.Element {
  return (
    <ul
      role="list"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400"
      aria-label="Credit-flow legend"
    >
      <li className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm bg-green-500/80 dark:bg-green-400/70"
          aria-hidden="true"
        />
        <span>Credited (in)</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500/70 dark:bg-rose-400/60"
          aria-hidden="true"
        />
        <span>Debited (out)</span>
      </li>
      <li className="inline-flex items-center gap-1.5 ml-2">
        <span className="font-semibold text-amber-700 dark:text-amber-400">Net</span>
        <span>= delta in outstanding liability</span>
      </li>
    </ul>
  );
}

function Chart({
  days,
  currency,
}: {
  days: TreasuryCreditFlowDay[];
  currency: Cur;
}): React.JSX.Element {
  const max = days.reduce((m, d) => {
    const c = BigInt(d.creditedMinor);
    const deb = BigInt(d.debitedMinor);
    const hi = c > deb ? c : deb;
    return hi > m ? hi : m;
  }, 0n);

  if (max === 0n) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No ledger activity for {currency} in the last 30 days.
      </p>
    );
  }

  return (
    <ul role="list" className="space-y-1">
      {days.map((d) => (
        <DayRow key={`${d.day}-${d.currency}`} day={d} currency={currency} max={max} />
      ))}
    </ul>
  );
}

function DayRow({
  day,
  currency,
  max,
}: {
  day: TreasuryCreditFlowDay;
  currency: Cur;
  max: bigint;
}): React.JSX.Element {
  const credited = BigInt(day.creditedMinor);
  const debited = BigInt(day.debitedMinor);
  const net = BigInt(day.netMinor);
  // Scale to 1000 for float-safe percentage math on bigints.
  const creditedPct = max === 0n ? 0 : Number((credited * 1000n) / max) / 10;
  const debitedPct = max === 0n ? 0 : Number((debited * 1000n) / max) / 10;

  const netClass =
    net > 0n
      ? 'text-amber-700 dark:text-amber-400'
      : net < 0n
        ? 'text-blue-700 dark:text-blue-400'
        : 'text-gray-500 dark:text-gray-400';
  const netPrefix = net > 0n ? '+' : '';
  const netDisplay = `${netPrefix}${fmtMinor(net < 0n ? `-${absBig(net).toString()}` : net.toString(), currency)}`;

  const label = `${shortDay(day.day)}: credited ${fmtMinor(day.creditedMinor, currency)}, debited ${fmtMinor(day.debitedMinor, currency)}, net ${netDisplay}`;

  return (
    <li className="flex items-center gap-2 text-xs" aria-label={label}>
      <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">
        {shortDay(day.day)}
      </span>
      {/* Debited bar grows left of centre; credited grows right. */}
      <span className="flex h-3 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
        <span className="flex w-1/2 flex-row-reverse">
          <span
            className="bg-rose-500/70 dark:bg-rose-400/60"
            style={{ width: `${debitedPct}%` }}
            aria-hidden="true"
          />
        </span>
        <span className="flex w-1/2">
          <span
            className="bg-green-500/80 dark:bg-green-400/70"
            style={{ width: `${creditedPct}%` }}
            aria-hidden="true"
          />
        </span>
      </span>
      <span className={`shrink-0 w-24 tabular-nums text-right font-semibold ${netClass}`}>
        {netDisplay}
      </span>
    </li>
  );
}
