import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatMinorCurrency } from '@loop/shared';
import { getSupplierSpendActivity, type SupplierSpendActivityDay } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { shortDay } from './PaymentMethodActivityChart';

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

// F-WEBADMIN-09 (2026-06-30 cold audit): local fmtMinor replaced with
// the bigint-safe shared helper (CF-23).
const fmtMinor = formatMinorCurrency;

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
  // F-WEBADMIN-03 (2026-06-30 cold audit): malformed bigint from
  // server — skip this day's contribution to max rather than crash
  // the whole reduce.
  const max = days.reduce((m, d) => {
    let v: bigint;
    try {
      v = BigInt(d.wholesaleMinor);
    } catch {
      return m;
    }
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
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- ADR 042: Tailwind Preflight sets `list-style: none` on <ul>, which strips the implicit list/listitem role in Safari VoiceOver (a known WebKit quirk — Chrome/Firefox are unaffected). role="list" restores it. The rule can't see the CSS interaction, so this is a documented false positive, not a mistake. Tracked: docs/readiness-backlog-2026-07-03.md B-2.
    <ul role="list" className="space-y-1">
      {days.map((d) => {
        // Malformed bigint from server — skip the row rather than
        // crash the whole page.
        let v: bigint;
        try {
          v = BigInt(d.wholesaleMinor);
        } catch {
          return null;
        }
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
            <span className="shrink-0 w-24 tabular-nums text-end text-gray-700 dark:text-gray-300">
              {fmtMinor(d.wholesaleMinor, currency)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
