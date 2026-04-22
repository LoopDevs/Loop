import { useQuery } from '@tanstack/react-query';
import { getPublicCashbackStats, type PerCurrencyCashback } from '~/services/public-stats';

/**
 * Formats a per-currency minor amount as localised currency. Falls
 * back to a plain `<value> <code>` string for currencies that
 * `Intl.NumberFormat` doesn't know (shouldn't happen in practice —
 * we only ever emit USD/GBP/EUR today — but the guard costs nothing).
 */
export function fmtPerCurrency(entry: PerCurrencyCashback): string {
  const n = Number(entry.amountMinor);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: entry.currency,
      maximumFractionDigits: 0,
    }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(0)} ${entry.currency}`;
  }
}

/**
 * Chooses the largest per-currency cashback entry — the one users
 * actually care about for the marketing headline ("£X,XXX earned").
 * Undefined if the list is empty (pre-launch state).
 */
export function pickHeadlineCurrency(
  rows: PerCurrencyCashback[] | undefined,
): PerCurrencyCashback | undefined {
  if (rows === undefined || rows.length === 0) return undefined;
  let best: { row: PerCurrencyCashback; amount: bigint } | undefined;
  for (const r of rows) {
    let amount: bigint;
    try {
      amount = BigInt(r.amountMinor);
    } catch {
      continue;
    }
    if (best === undefined || amount > best.amount) best = { row: r, amount };
  }
  return best?.row;
}

/**
 * Home-page social-proof band: "N users earned X cashback on Y gift
 * cards". Pulls from the public, CDN-friendly stats endpoint which
 * never-500s — zero is a valid bootstrap state, not an error. The
 * band hides itself entirely while the first fetch is in flight so
 * the page doesn't flash "0 users" then the real number.
 */
export function CashbackStatsBand(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['public-cashback-stats'],
    queryFn: getPublicCashbackStats,
    // Marketing surface: cache aggressively. Backend has its own
    // Cache-Control too, so the second fetch by any visitor is served
    // from the edge anyway.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Skip render on loading + error; treat a zero snapshot (bootstrap
  // state, no orders yet) the same way so the hero doesn't trumpet
  // a trivial number. Once the numbers cross a threshold the band
  // shows up for every visitor.
  if (query.isPending || query.isError) return null;
  const data = query.data;
  if (data.totalUsersWithCashback === 0 && data.fulfilledOrders === 0) return null;

  const headline = pickHeadlineCurrency(data.totalCashbackByCurrency);

  return (
    <section
      aria-label="Loop cashback totals"
      className="max-w-4xl mx-auto rounded-2xl border border-green-200 bg-green-50 px-6 py-4 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-300"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-6 text-center">
        <div>
          <div className="text-2xl font-semibold tabular-nums">
            {data.totalUsersWithCashback.toLocaleString('en-US')}
          </div>
          <div className="text-xs uppercase tracking-wide opacity-80">Users earning cashback</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums">
            {headline !== undefined ? fmtPerCurrency(headline) : '—'}
          </div>
          <div className="text-xs uppercase tracking-wide opacity-80">Cashback paid out</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums">
            {data.fulfilledOrders.toLocaleString('en-US')}
          </div>
          <div className="text-xs uppercase tracking-wide opacity-80">Gift cards bought</div>
        </div>
      </div>
    </section>
  );
}
