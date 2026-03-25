import type { Location } from './algorithm.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { upstreamCircuit } from '../circuit-breaker.js';

interface ApiLocationResponse {
  pagination: {
    page: number;
    pages: number;
    perPage: number;
    total: number;
  };
  result: Array<{
    id: string;
    merchantId: string;
    enabled: boolean;
    latLong: {
      latitude: string;
      longitude: string;
    };
    mapPinUrl?: string;
  }>;
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
  let page = 1;
  let totalPages = 1;

  try {
    while (page <= totalPages) {
      const base = env.GIFT_CARD_API_BASE_URL.replace(/\/$/, '');
      const url = new URL(`${base}/locations`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '500');

      const headers: Record<string, string> = {};
      if (env.GIFT_CARD_API_KEY) {
        headers['X-Api-Key'] = env.GIFT_CARD_API_KEY;
      }
      if (env.GIFT_CARD_API_SECRET) {
        headers['X-Api-Secret'] = env.GIFT_CARD_API_SECRET;
      }

      const response = await upstreamCircuit.fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Upstream locations API returned ${response.status}`);
      }

      const data = (await response.json()) as ApiLocationResponse;
      totalPages = data.pagination.pages;

      for (const item of data.result) {
        if (!item.enabled) continue;

        const lat = parseFloat(item.latLong.latitude);
        const lng = parseFloat(item.latLong.longitude);

        if (isNaN(lat) || isNaN(lng)) continue;

        locations.push({
          merchantId: item.merchantId,
          mapPinUrl: item.mapPinUrl ?? null,
          latitude: lat,
          longitude: lng,
        });
      }

      page++;
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
