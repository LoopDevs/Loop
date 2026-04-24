import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSupplierSpendActivity, type SupplierSpendActivityDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { shortDay } from './PaymentMethodActivityChart';
import { ADMIN_LOCALE } from '~/utils/locale';

/**
 * CSS-only per-day bar chart of supplier-spend over the last N days
 * for one currency. Consumes `/api/admin/supplier-spend/activity`.
 *
 * Sits below the 24h `SupplierSpendCard` snapshot on
 * `/admin/treasury` — snapshot says *how much* we paid CTX in the
 * window, this says *when*. The full treasury-velocity triplet is
 * credit-flow (ledger in) + supplier-spend/activity (CTX out) +
 * payouts-activity (chain out).
 *
 * Bars are scaled against the window max so an unusually large day
 * doesn't flatten every other bar to invisibility. `wholesaleMinor`
 * is the axis users care about — that's what Loop actually paid CTX.
 */
const CURRENCIES = ['USD', 'GBP', 'EUR'] as const;
type Cur = (typeof CURRENCIES)[number];

const CURRENCY_SYMBOL: Record<Cur, string> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
};

function fmtMinor(minor: string, currency: Cur): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const sign = negative ? '-' : '';
  return `${sign}${CURRENCY_SYMBOL[currency]}${Number(whole).toLocaleString(ADMIN_LOCALE)}.${fraction}`;
}

export function SupplierSpendActivityChart(): React.JSX.Element {
  const [currency, setCurrency] = useState<Cur>('USD');

  const query = useQuery({
    queryKey: ['admin-supplier-spend-activity', currency, 30],
    queryFn: () => getSupplierSpendActivity({ days: 30, currency }),
    retry: shouldRetry,
    staleTime: 60_000,
  });

  return (
    <div>
      <CurrencyPicker value={currency} onChange={setCurrency} />
      <div className="mt-3">
        {query.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : query.isError ? (
          <p className="py-4 text-sm text-red-600 dark:text-red-400">
            Failed to load supplier-spend activity.
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
      aria-label="Supplier-spend currency filter"
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

function Chart({
  days,
  currency,
}: {
  days: SupplierSpendActivityDay[];
  currency: Cur;
}): React.JSX.Element {
  const max = days.reduce((m, d) => {
    const v = BigInt(d.wholesaleMinor);
    return v > m ? v : m;
  }, 0n);

  if (max === 0n) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No fulfilled {currency} orders in the last 30 days — no supplier spend to chart.
      </p>
    );
  }

  return (
    <ul role="list" className="space-y-1">
      {days.map((d) => {
        const v = BigInt(d.wholesaleMinor);
        // Scale to 1000 for float-safe percentage math on bigints.
        const widthPct = Number((v * 1000n) / max) / 10;
        return (
          <li
            key={`${d.day}-${d.currency}`}
            className="flex items-center gap-2 text-xs"
            aria-label={`${shortDay(d.day)}: ${fmtMinor(d.wholesaleMinor, currency)} wholesale`}
          >
            <span className="shrink-0 w-16 tabular-nums text-gray-500 dark:text-gray-400">
              {shortDay(d.day)}
            </span>
            <span className="flex h-3 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
              <span
                className="bg-orange-500/70 dark:bg-orange-400/60"
                style={{ width: `${widthPct}%` }}
                aria-hidden="true"
              />
            </span>
            <span className="shrink-0 w-24 tabular-nums text-right text-gray-700 dark:text-gray-300">
              {fmtMinor(d.wholesaleMinor, currency)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
