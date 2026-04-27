/**
 * Merchant-sync interval-loop bootstrap (ADR 011).
 *
 * Lifted out of `./sync.ts` so the periodic-refresh timer
 * (start/stop) lives separately from the request-time refresh
 * logic. Mirrors the pattern used by the procurement worker
 * (`procurement-worker.ts`), the asset-drift watcher's interval
 * loop, and the pending-payouts state-transition split — request-
 * time work in the primary file, scheduling concerns alongside.
 *
 * Re-exported from `./sync.ts` so existing import sites (`index.ts`,
 * graceful shutdown) keep resolving against the historical path.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getMerchants, refreshMerchants } from './sync.js';

const log = logger.child({ module: 'merchants-sync' });

let refreshInterval: NodeJS.Timeout | null = null;

/** Starts the background refresh timer. Call once at startup. */
export function startMerchantRefresh(): void {
  void refreshMerchants();

  const intervalMs = env.REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  const staleMs = intervalMs * 2;
  refreshInterval = setInterval(() => {
    const store = getMerchants();
    if (Date.now() - store.loadedAt > staleMs && store.merchants.length > 0) {
      log.warn(
        { ageMs: Date.now() - store.loadedAt, threshold: staleMs },
        'Merchant data is stale — refresh may be failing',
      );
    }
    void refreshMerchants();
  }, intervalMs);
}

/** Stops the background refresh timer. Intended for graceful shutdown. */
export function stopMerchantRefresh(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
