// Merchant-sync interval-loop bootstrap — ADR 011
import { logger } from '../logger.js';
import { getMerchants, refreshMerchants, warmStartMerchantsFromSnapshot } from './sync.js';

const log = logger.child({ module: 'merchants-sync' });

// Fixed hourly sweep — deliberately NOT configurable. The sweep is only
// the fallback reconciler behind the ws maintainer (./ws-events.ts),
// so a cadence knob would be dead config; one full catalog request per
// hour is negligible load either way.
export const MERCHANT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let refreshInterval: NodeJS.Timeout | null = null;

export async function startMerchantRefresh(): Promise<void> {
  await warmStartMerchantsFromSnapshot();
  void refreshMerchants();

  const intervalMs = MERCHANT_REFRESH_INTERVAL_MS;
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

export function stopMerchantRefresh(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
