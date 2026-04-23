import { useQuery } from '@tanstack/react-query';
import { getAssetDriftState, type AssetDriftStateResponse } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';

/**
 * `/admin` landing card — at-a-glance summary of the background
 * asset-drift watcher (ADR 015). Reads the in-memory snapshot
 * endpoint (`/api/admin/asset-drift/state`), so the read is cheap
 * and no browser-load forces a Horizon call.
 *
 * Three surfaces the operator cares about:
 *   - is the watcher alive? (`running` + `lastTickMs`)
 *   - how many of the configured assets are currently drifted past
 *     threshold? (the "is anything on fire" signal)
 *   - which ones? (named so triage can start from here)
 *
 * Self-hides when the watcher hasn't been started (no configured
 * issuers) so the landing layout doesn't show a dead card on a
 * partially-configured deployment — ops sees the per-asset drift
 * badges in the liability strip instead.
 */
export function AssetDriftWatcherCard(): React.JSX.Element | null {
  const query = useQuery<AssetDriftStateResponse, Error>({
    queryKey: ['admin-asset-drift-state'],
    queryFn: getAssetDriftState,
    retry: shouldRetry,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (query.isPending || query.isError) return null;
  const data = query.data;

  // Watcher inactive + no assets: nothing to show. A configured
  // deployment always has at least one row here.
  if (!data.running && data.perAsset.length === 0) return null;

  const overAssets = data.perAsset.filter((a) => a.state === 'over');
  const unknownAssets = data.perAsset.filter((a) => a.state === 'unknown');
  const ok = data.perAsset.length - overAssets.length - unknownAssets.length;

  const anyOver = overAssets.length > 0;

  return (
    <section
      className={`rounded-xl border p-4 ${
        anyOver
          ? 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-900/20'
          : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900'
      }`}
      aria-label="Asset drift watcher status"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Drift watcher</h2>
        <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {data.running ? 'running' : 'inactive'}
        </span>
      </div>
      <div className="mt-2 text-sm tabular-nums">
        {anyOver ? (
          <span className="text-amber-800 dark:text-amber-300">
            {overAssets.length} / {data.perAsset.length} over threshold —{' '}
            <span className="font-mono">{overAssets.map((a) => a.assetCode).join(', ')}</span>
          </span>
        ) : ok === data.perAsset.length ? (
          <span className="text-gray-700 dark:text-gray-300">
            {ok} / {data.perAsset.length} assets within threshold
          </span>
        ) : (
          <span className="text-gray-500 dark:text-gray-400">
            {unknownAssets.length} pending first read
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {data.lastTickMs !== null ? (
          <>Last tick {formatAgo(data.lastTickMs)}</>
        ) : (
          <>Watcher has not run yet</>
        )}
      </div>
    </section>
  );
}

export function formatAgo(tickMs: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - tickMs);
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
