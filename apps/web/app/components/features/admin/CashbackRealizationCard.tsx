import { useQuery } from '@tanstack/react-query';
import { getCashbackRealization, type CashbackRealizationResponse } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * `/admin` landing — cashback realization rate (ADR 009 / 015).
 * Completes the three-signal operator dashboard alongside the drift
 * watcher (ledger parity) + settlement-lag (SLA):
 *
 *   - Drift = are mint and ledger in agreement?
 *   - Lag   = are payouts fast enough users don't feel the queue?
 *   - Realization = are users spending cashback back on Loop, or
 *                   is it sitting as stagnant liability?
 *
 * Fleet-wide `recycledBps` headline (two-decimal percent) reads
 * off the `currency: null` aggregate row. Per-currency table
 * below fills in the breakdown when more than one currency has
 * seen activity — single-currency deployments stay compact.
 *
 * Self-hides on empty / error — the landing page already has the
 * drift and lag cards to cover the operator's first glance.
 */
export function CashbackRealizationCard(): React.JSX.Element | null {
  const query = useQuery<CashbackRealizationResponse, Error>({
    queryKey: ['admin-cashback-realization'],
    queryFn: getCashbackRealization,
    retry: shouldRetry,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (query.isPending || query.isError) return null;
  const data = query.data;
  const fleet = data.rows.find((r) => r.currency === null);
  if (fleet === undefined) return null;

  const perCurrency = data.rows.filter((r) => r.currency !== null);

  // Fleet earnedMinor == 0 is the "no cashback ever emitted" state.
  // Render a muted zero headline so ops can distinguish "0%" from
  // "card crashed" during a fresh deployment.
  const earnedIsZero = fleet.earnedMinor === '0';

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
      aria-label="Cashback realization"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          Cashback realization
        </h2>
        <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          spent / earned
        </span>
      </div>

      <div className="mt-3">
        <div
          className={`text-3xl font-semibold tabular-nums ${
            earnedIsZero ? 'text-gray-500 dark:text-gray-500' : 'text-gray-900 dark:text-white'
          }`}
        >
          {formatBps(fleet.recycledBps)}
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {earnedIsZero
            ? 'No cashback emitted yet.'
            : 'Share of emitted cashback that has been recycled into new Loop orders.'}
        </p>
      </div>

      {perCurrency.length > 1 ? (
        <table className="mt-4 w-full text-xs tabular-nums">
          <thead className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <th className="pb-1 text-left font-medium">Currency</th>
              <th className="pb-1 text-right font-medium">Earned</th>
              <th className="pb-1 text-right font-medium">Spent</th>
              <th className="pb-1 text-right font-medium">Recycled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700 dark:text-gray-300">
            {perCurrency.map((r) => (
              <tr key={r.currency ?? ''}>
                <td className="py-0.5 font-mono">{r.currency}</td>
                <td className="py-0.5 text-right">
                  {formatMinor(r.earnedMinor, r.currency ?? 'USD')}
                </td>
                <td className="py-0.5 text-right">
                  {formatMinor(r.spentMinor, r.currency ?? 'USD')}
                </td>
                <td className="py-0.5 text-right">{formatBps(r.recycledBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** basis points → `"X.XX%"`. Integer bps clamped [0, 10 000] by the server. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${pct.toFixed(2)}%`;
}

/** Minor-units bigint-string → localised currency label. */
export function formatMinor(minor: string, currency: string): string {
  try {
    const major = Number(BigInt(minor)) / 100;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0,
    }).format(major);
  } catch {
    return '—';
  }
}
