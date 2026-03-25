import type { Location } from './algorithm.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { upstreamCircuit } from '../circuit-breaker.js';

/** Shape returned by the upstream CTX /dcg/locations endpoint (flat array). */
interface UpstreamLocation {
  merchantId: string;
  active: boolean;
  latitude: number;
  longitude: number;
  logoLocation?: string;
  name?: string;
  city?: string;
}

interface StoreData {
  locations: Location[];
  loadedAt: number;
}

/** In-memory location store. Updated atomically on refresh. */
let store: StoreData = { locations: [], loadedAt: Date.now() };

/** Returns the current snapshot. Callers should not hold references across awaits. */
export function getLocations(): StoreData {
  return store;
}

let isLocationRefreshing = false;

/**
 * Fetches all location pages from the upstream API and atomically replaces
 * the in-memory store.
 */
export async function refreshLocations(): Promise<void> {
  if (isLocationRefreshing) return;
  isLocationRefreshing = true;
  const log = logger.child({ module: 'data-store' });
  log.info('Refreshing location data from upstream API');

  const locations: Location[] = [];

  try {
    const base = env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '');
    const url = `${base}/dcg/locations`;

    const headers: Record<string, string> = {};
    if (env.GIFT_CARD_API_KEY) {
      headers['X-Api-Key'] = env.GIFT_CARD_API_KEY;
    }
    if (env.GIFT_CARD_API_SECRET) {
      headers['X-Api-Secret'] = env.GIFT_CARD_API_SECRET;
    }

    const response = await upstreamCircuit.fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Upstream locations API returned ${response.status}`);
    }

    // /dcg/locations returns a flat array (no pagination wrapper)
    const data = (await response.json()) as UpstreamLocation[];

    for (const item of data) {
      if (!item.active) continue;
      if (item.latitude === 0 && item.longitude === 0) continue;
      if (isNaN(item.latitude) || isNaN(item.longitude)) continue;

      locations.push({
        merchantId: item.merchantId,
        mapPinUrl: item.logoLocation ?? null,
        latitude: item.latitude,
        longitude: item.longitude,
      });
    }

    // Atomic hot-swap — callers in flight with the old reference are unaffected
    store = { locations, loadedAt: Date.now() };
    log.info({ count: locations.length }, 'Location data refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh location data — retaining previous data');
  } finally {
    isLocationRefreshing = false;
  }
}

/** Starts the background refresh timer. Call once at startup. */
export function startLocationRefresh(): void {
  const log = logger.child({ module: 'data-store' });
  void refreshLocations();

  const intervalMs = env.LOCATION_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  const staleMs = intervalMs * 2;
  setInterval(() => {
    if (Date.now() - store.loadedAt > staleMs && store.locations.length > 0) {
      log.warn(
        { ageMs: Date.now() - store.loadedAt, threshold: staleMs },
        'Location data is stale — refresh may be failing',
      );
    }
    void refreshLocations();
  }, intervalMs);
}
