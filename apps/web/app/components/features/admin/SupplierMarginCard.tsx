import { useQuery } from '@tanstack/react-query';
import { getSupplierMargin, type SupplierMarginResponse } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * `/admin` landing — supplier-margin summary (ADR 011/013/015/024).
 *
 * Fourth signal on the operator dashboard, validating ADR 024's
 * three-signal pattern. Adjacent KPI to realization:
 *
 *   - Realization = "are users recycling cashback?" (flywheel flow)
 *   - Margin      = "what share of each order does Loop keep?" (commercial)
 *
 * Fleet-wide `marginBps` headline (two-decimal percent) reads off
 * the `currency: null` aggregate row. Per-currency breakdown table
 * renders when >1 currency has activity.
 *
 * Self-hides on empty / error — the drift / lag / realization cards
 * already cover the landing page's first glance.
 */
export function SupplierMarginCard(): React.JSX.Element | null {
  const query = useQuery<SupplierMarginResponse, Error>({
    queryKey: ['admin-supplier-margin'],
    queryFn: getSupplierMargin,
    retry: shouldRetry,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (query.isPending || query.isError) return null;
  const data = query.data;
  const fleet = data.rows.find((r) => r.currency === null);
  if (fleet === undefined) return null;

  const perCurrency = data.rows.filter((r) => r.currency !== null);

  // Fleet chargeMinor == '0' is the "no fulfilled orders ever" state.
  // Distinct zero headline so ops can distinguish "0%" from a render
  // crash on a fresh deployment.
  const chargeIsZero = fleet.chargeMinor === '0';

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
      aria-label="Supplier margin"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Supplier margin</h2>
        <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          loop margin / charge
        </span>
      </div>

      <div className="mt-3">
        <div
          className={`text-3xl font-semibold tabular-nums ${
            chargeIsZero ? 'text-gray-500 dark:text-gray-500' : 'text-gray-900 dark:text-white'
          }`}
        >
          {formatBps(fleet.marginBps)}
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {chargeIsZero
            ? 'No fulfilled orders yet.'
            : `Retained margin across ${fleet.orderCount.toLocaleString('en-US')} fulfilled orders.`}
        </p>
      </div>

      {perCurrency.length > 1 ? (
        <table className="mt-4 w-full text-xs tabular-nums">
          <thead className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <th className="pb-1 text-left font-medium">Currency</th>
              <th className="pb-1 text-right font-medium">Orders</th>
              <th className="pb-1 text-right font-medium">Margin</th>
              <th className="pb-1 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="text-gray-700 dark:text-gray-300">
            {perCurrency.map((r) => (
              <tr key={r.currency ?? ''}>
                <td className="py-0.5 font-mono">{r.currency}</td>
                <td className="py-0.5 text-right">{r.orderCount.toLocaleString('en-US')}</td>
                <td className="py-0.5 text-right">
                  {formatMinor(r.loopMarginMinor, r.currency ?? 'USD')}
                </td>
                <td className="py-0.5 text-right">{formatBps(r.marginBps)}</td>
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
