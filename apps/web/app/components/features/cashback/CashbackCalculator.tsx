import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatMinorCurrency } from '@loop/shared';
import { currencySymbol } from '~/i18n/format';
import { getPublicCashbackPreview, type PublicCashbackPreview } from '~/services/public-stats';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * Pre-signup cashback calculator for the `/cashback/:slug` SEO
 * landing page (#735 / ADR 020). A visitor arriving from a
 * "cashback at amazon" search types an amount, sees the projected
 * cashback update — the pre-signup equivalent of the logged-in
 * `AmountSelection` estimate row.
 *
 * Debounced to 300ms so fast typing doesn't hammer the endpoint;
 * TanStack-queried so paging between amounts within the debounce
 * window hits the 60s backend cache.
 *
 * Self-contained — takes only `merchantId` as a prop, reads the
 * backend-rendered merchant name / currency / pct straight off the
 * preview response. Rendering falls back to an em-dash when the
 * merchant has no active cashback config (pct === null) rather
 * than a misleading "\$0.00".
 */

const DEFAULT_AMOUNT = 50;
const DEBOUNCE_MS = 300;

interface Props {
  merchantId: string;
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * WUM-04 (2026-06-30 cold audit): delegates to the canonical
 * bigint-exact shared formatter (CF-23) instead of `Number(BigInt(minor))
 * / 100` — kept as a thin named wrapper since this file's own test
 * suite asserts on it directly and other call sites in this file use
 * the short name.
 */
export function formatCashbackMinor(minor: string, currency: string): string {
  return formatMinorCurrency(minor, currency);
}

export function CashbackCalculator({ merchantId }: Props): React.JSX.Element {
  const [amount, setAmount] = useState<number>(DEFAULT_AMOUNT);
  const debouncedAmount = useDebouncedValue(amount, DEBOUNCE_MS);

  // amountMinor rounded to whole cents; negative/NaN/zero all skip
  // the fetch since the backend rejects them with 400.
  const amountMinor = Math.round(debouncedAmount * 100);
  const enabled = Number.isFinite(amountMinor) && amountMinor > 0;

  const query = useQuery<PublicCashbackPreview, Error>({
    queryKey: ['public-cashback-preview', merchantId, amountMinor],
    queryFn: () => getPublicCashbackPreview({ merchantId, amountMinor }),
    retry: shouldRetry,
    enabled,
    staleTime: 60_000,
  });

  const data = query.data;
  const pctLabel =
    data?.cashbackPct !== null && data?.cashbackPct !== undefined
      ? `${Number(data.cashbackPct).toFixed(2).replace(/\.0+$/, '')}%`
      : '—';
  const cashbackLabel =
    data !== undefined && data.cashbackPct !== null
      ? formatCashbackMinor(data.cashbackMinor, data.currency)
      : '—';
  // Input glyph must match the merchant's real currency (P2-09): a UK
  // merchant's calculator showed a hardcoded `$` on the input while the
  // output rendered `£`. Derive the symbol from the same currency the
  // output formats with (`data.currency`) via the shared `currencySymbol`
  // seam so input and output agree; `$` is only the pre-load placeholder
  // shown before the preview resolves.
  const currencyGlyph = data !== undefined ? currencySymbol(data.currency) : '$';

  return (
    <section
      aria-labelledby="cashback-calculator-heading"
      className="rounded-xl border border-green-200 bg-green-50 p-5 dark:border-green-900/60 dark:bg-green-900/20"
    >
      <h2
        id="cashback-calculator-heading"
        className="text-base font-semibold text-green-900 dark:text-green-100"
      >
        Calculate your cashback
      </h2>
      <p className="mt-1 text-sm text-green-800 dark:text-green-200">
        Enter a gift-card amount and we&rsquo;ll show what you&rsquo;d earn.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-green-900/80 dark:text-green-100/80">
          Amount
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-lg text-green-900 dark:text-green-100">
              {currencyGlyph}
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={10000}
              step={1}
              value={amount}
              onChange={(e) => {
                const n = Number(e.target.value);
                setAmount(Number.isFinite(n) ? n : 0);
              }}
              aria-label="Gift card amount"
              className="w-28 rounded-md border border-green-300 bg-white px-3 py-2 text-base tabular-nums text-gray-900 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 dark:border-green-800 dark:bg-gray-900 dark:text-white"
            />
          </div>
        </label>
        <div className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-green-900/80 dark:text-green-100/80">
          Rate
          <span className="text-lg font-semibold tabular-nums text-green-900 dark:text-green-100">
            {pctLabel}
          </span>
        </div>
        <div className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-green-900/80 dark:text-green-100/80">
          You&rsquo;ll earn
          <span className="text-lg font-semibold tabular-nums text-green-900 dark:text-green-100">
            {cashbackLabel}
          </span>
        </div>
      </div>
    </section>
  );
}
