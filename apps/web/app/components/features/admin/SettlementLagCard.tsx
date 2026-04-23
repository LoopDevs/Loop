import { useQuery } from '@tanstack/react-query';
import { getSettlementLag, type SettlementLagResponse } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * `/admin` landing — payout settlement-lag SLA card (ADR 015/016).
 * Paired with the drift-watcher card: drift = ledger health,
 * settlement-lag = "is settlement fast enough that users don't feel
 * the queue?". Both read fleet-wide + per-asset signals at once so
 * the landing page reads as a stablecoin operator dashboard rather
 * than a per-surface drill.
 *
 * Fleet-wide p50 / p95 / max come from the `assetCode: null` row
 * the backend emits via `GROUPING SETS ((asset_code), ())`.
 * Per-asset rows list only codes with >= 1 sample in the 24h window
 * (absent rows = no confirmed payouts in that asset, not a zero
 * reading). Self-hides when no rows land — a freshly-configured
 * deployment with no payouts yet shouldn't show empty percentile
 * boxes implying "p50 = 0s, everything's fast".
 */
export function SettlementLagCard(): React.JSX.Element | null {
  const query = useQuery<SettlementLagResponse, Error>({
    queryKey: ['admin-settlement-lag'],
    queryFn: () => getSettlementLag(),
    retry: shouldRetry,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (query.isPending || query.isError) return null;
  const data = query.data;
  if (data.rows.length === 0) return null;

  const fleet = data.rows.find((r) => r.assetCode === null);
  const perAsset = data.rows.filter((r) => r.assetCode !== null);

  // No fleet-wide row means GROUPING SETS fired but no confirmed
  // rows in window — the per-asset block would also be empty.
  if (fleet === undefined) return null;

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
      aria-label="Payout settlement-lag"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Settlement lag</h2>
        <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          last 24h · n={fleet.sampleCount}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            p50
          </dt>
          <dd className="mt-0.5 font-semibold text-gray-900 dark:text-white tabular-nums">
            {formatSeconds(fleet.p50Seconds)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            p95
          </dt>
          <dd className="mt-0.5 font-semibold text-gray-900 dark:text-white tabular-nums">
            {formatSeconds(fleet.p95Seconds)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            max
          </dt>
          <dd className="mt-0.5 font-semibold text-gray-900 dark:text-white tabular-nums">
            {formatSeconds(fleet.maxSeconds)}
          </dd>
        </div>
      </dl>

      {perAsset.length > 0 ? (
        <table className="mt-4 w-full text-xs tabular-nums">
          <thead className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <tr>
              <th className="pb-1 text-left font-medium">Asset</th>
              <th className="pb-1 text-right font-medium">n</th>
              <th className="pb-1 text-right font-medium">p50</th>
              <th className="pb-1 text-right font-medium">p95</th>
            </tr>
          </thead>
          <tbody className="text-gray-700 dark:text-gray-300">
            {perAsset.map((r) => (
              <tr key={r.assetCode ?? ''}>
                <td className="py-0.5 font-mono">{r.assetCode}</td>
                <td className="py-0.5 text-right">{r.sampleCount}</td>
                <td className="py-0.5 text-right">{formatSeconds(r.p50Seconds)}</td>
                <td className="py-0.5 text-right">{formatSeconds(r.p95Seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/**
 * Seconds → short human label. <60s stays in seconds; minutes rounded
 * to one decimal place; ≥1h switches to hours with one decimal.
 *
 * Percentile math often comes back as a fractional second like
 * `45.3` — we round down to `45s`. A p95 of `4505s` reads as `1.3h`,
 * not `75m`, so ops can tell at a glance which side of the hour
 * boundary we're on during an incident.
 */
export function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
