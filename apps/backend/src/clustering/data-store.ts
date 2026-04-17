import type { Location } from './algorithm.js';
import { z } from 'zod';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { getUpstreamCircuit } from '../circuit-breaker.js';
import { upstreamUrl } from '../upstream.js';
import { getMerchants } from '../merchants/sync.js';

/**
 * Zod schema for a single upstream location entry. Required fields are strict;
 * `mapPinUrl` is optional. `.passthrough()` preserves unknown fields.
 */
const UpstreamLocationSchema = z
  .object({
    id: z.string(),
    merchantId: z.string().min(1),
    enabled: z.boolean(),
    latLong: z.object({
      latitude: z.string(),
      longitude: z.string(),
    }),
    mapPinUrl: z.string().optional(),
  })
  .passthrough();

const UpstreamLocationsResponseSchema = z
  .object({
    pagination: z.object({
      page: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      perPage: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    // Validate individually inside the loop so one malformed record does not
    // poison the whole page.
    result: z.array(z.unknown()),
  })
  .passthrough();

// Defensive ceiling on pagination. The locations catalog has grown past 1000
// pages historically; 500 at perPage=1000 gives us 500k records which is
// already well beyond realistic, and stops runaway loops on upstream bugs.
const MAX_PAGES = 500;

interface StoreData {
  locations: Location[];
  loadedAt: number;
}

// loadedAt starts at 0 so /health reports locations stale until the first
// successful refresh lands, rather than pretending fresh during the ~48h
// window before the first real load completes.
let store: StoreData = { locations: [], loadedAt: 0 };

/** Returns the current snapshot. Callers should not hold references across awaits. */
export function getLocations(): StoreData {
  return store;
}

let isLocationRefreshing = false;

/** Returns true while a location refresh is in progress. */
export function isLocationLoading(): boolean {
  return isLocationRefreshing;
}

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
    while (page <= totalPages && page <= MAX_PAGES) {
      const url = new URL(upstreamUrl('/locations'));
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '1000');

      const headers: Record<string, string> = {};
      if (env.GIFT_CARD_API_KEY) {
        headers['X-Api-Key'] = env.GIFT_CARD_API_KEY;
      }
      if (env.GIFT_CARD_API_SECRET) {
        headers['X-Api-Secret'] = env.GIFT_CARD_API_SECRET;
      }

      const response = await getUpstreamCircuit('locations').fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Upstream locations API returned ${response.status}`);
      }

      const raw = await response.json();
      const parsed = UpstreamLocationsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `Upstream locations response has unexpected shape: ${parsed.error.message}`,
        );
      }
      totalPages = parsed.data.pagination.pages;

      // Cross-reference with merchant data for mapPinUrl (logos)
      // The /locations endpoint doesn't include mapPinUrl — it comes from /merchants
      const { merchantsById } = getMerchants();

      for (const rawItem of parsed.data.result) {
        const itemParsed = UpstreamLocationSchema.safeParse(rawItem);
        if (!itemParsed.success) {
          log.warn(
            { issues: itemParsed.error.issues },
            'Skipping malformed location from upstream',
          );
          continue;
        }
        const item = itemParsed.data;
        if (!item.enabled) continue;

        const lat = parseFloat(item.latLong.latitude);
        const lng = parseFloat(item.latLong.longitude);

        if (isNaN(lat) || isNaN(lng)) continue;
        if (lat === 0 && lng === 0) continue;
        // Reject physically impossible coordinates — guards against unit
        // confusion or bad geocodes slipping past the upstream parser.
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

        // Look up merchant logo from the merchant store
        const merchant = merchantsById.get(item.merchantId);
        const mapPinUrl = item.mapPinUrl ?? merchant?.logoUrl ?? null;

        locations.push({
          merchantId: item.merchantId,
          mapPinUrl,
          latitude: lat,
          longitude: lng,
        });
      }

      if (page % 10 === 0 || page === totalPages) {
        log.info({ page, totalPages, locationsSoFar: locations.length }, 'Location sync progress');
      }

      page++;
    }
    if (page > MAX_PAGES && page <= totalPages) {
      log.warn({ page, totalPages }, 'Hit MAX_PAGES cap while paginating locations — truncating');
    }

    store = { locations, loadedAt: Date.now() };
    log.info({ count: locations.length }, 'Location data refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh location data — retaining previous data');
  } finally {
    isLocationRefreshing = false;
  }
}

let refreshInterval: NodeJS.Timeout | null = null;

/** Starts the background refresh timer. Call once at startup. */
export function startLocationRefresh(): void {
  const log = logger.child({ module: 'data-store' });
  void refreshLocations();

  const intervalMs = env.LOCATION_REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
  const staleMs = intervalMs * 2;
  refreshInterval = setInterval(() => {
    if (Date.now() - store.loadedAt > staleMs && store.locations.length > 0) {
      log.warn(
        { ageMs: Date.now() - store.loadedAt, threshold: staleMs },
        'Location data is stale — refresh may be failing',
      );
    }
    void refreshLocations();
  }, intervalMs);
}

/** Stops the background refresh timer. Intended for graceful shutdown. */
export function stopLocationRefresh(): void {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
