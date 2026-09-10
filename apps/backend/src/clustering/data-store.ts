import type { Location } from './algorithm.js';
import { z } from 'zod';
import { logger } from '../logger.js';
import { config } from '../config/index.js';
import { upstreamUrl, upstreamFetch } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { getMerchants } from '../merchants/sync.js';
import { loadCatalogSnapshot, saveCatalogSnapshot } from '../ctx/catalog-snapshots.js';

// Size caps prevent a compromised upstream from exhausting memory or injecting unbounded data into the in-memory store.
const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_COORD_LENGTH = 32;
// Cap single page array at 5x requested perPage to bound total records held during sync.
const MAX_RESULT_COUNT = 5000;

// FT-15: Length-capped string fields ensure oversized values are skipped rather than absorbed.
const UpstreamLocationSchema = z
  .object({
    id: z.string().max(MAX_ID_LENGTH),
    merchantId: z.string().min(1).max(MAX_ID_LENGTH),
    enabled: z.boolean(),
    latLong: z.object({
      latitude: z.string().max(MAX_COORD_LENGTH),
      longitude: z.string().max(MAX_COORD_LENGTH),
    }),
    mapPinUrl: z.string().max(MAX_URL_LENGTH).optional(),
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
    // FT-15: Reject oversized pages wholesale to prevent loading unbounded arrays into memory.
    result: z.array(z.unknown()).max(MAX_RESULT_COUNT),
  })
  .passthrough();

// Defensive ceiling to stop runaway pagination loops on upstream bugs.
const MAX_PAGES = 500;

interface StoreData {
  locations: Location[];
  loadedAt: number;
}

// loadedAt starts at 0 so /health reports stale status until the first successful refresh.
let store: StoreData = { locations: [], loadedAt: 0 };

/** Returns the current snapshot. Callers should not hold references across awaits. */
export function getLocations(): StoreData {
  return store;
}

// ADR 050: Per-merchant map-pin lookup for reference-keyed image proxy.
// Built lazily and invalidated by store identity; first location with a pin wins.
let pinIndexSource: StoreData | null = null;
let pinIndex = new Map<string, string>();

/** Returns the merchant's map-pin URL from the locations feed, or null. */
export function getMapPinUrl(merchantId: string): string | null {
  if (pinIndexSource !== store) {
    const index = new Map<string, string>();
    for (const location of store.locations) {
      if (location.mapPinUrl !== null && !index.has(location.merchantId)) {
        index.set(location.merchantId, location.mapPinUrl);
      }
    }
    pinIndex = index;
    pinIndexSource = store;
  }
  return pinIndex.get(merchantId) ?? null;
}

let isLocationRefreshing = false;

/** Returns true while a location refresh is in progress. */
export function isLocationLoading(): boolean {
  return isLocationRefreshing;
}

export function __resetLocationStoreForTests(): void {
  store = { locations: [], loadedAt: 0 };
  isLocationRefreshing = false;
  hasWarnedStale = false;
}

export async function warmStartLocationsFromSnapshot(): Promise<boolean> {
  if (store.locations.length > 0) return false;
  const log = logger.child({ module: 'data-store' });
  try {
    const snapshot = await loadCatalogSnapshot<Location>('locations');
    if (snapshot === null) return false;
    store = { locations: snapshot.items, loadedAt: snapshot.loadedAt };
    log.info({ count: snapshot.items.length }, 'Location data warm-started from Postgres snapshot');
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to warm-start location data from Postgres snapshot');
    return false;
  }
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

      const headers: Record<string, string> = {
        'X-Api-Key': config.ctx.credentials.key,
        'X-Api-Secret': config.ctx.credentials.secret,
      };

      const response = await upstreamFetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        // A2-1306: Scrub JWT / opaque-token / email / card substrings before logging.
        const body = await response.text().catch(() => '');
        log.error(
          { status: response.status, body: scrubUpstreamBody(body), page },
          'Upstream locations API returned non-ok status',
        );
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

      // mapPinUrl comes from /merchants, not /locations
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
        // Reject physically impossible coordinates to guard against unit confusion or bad geocodes.
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

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

    const loadedAt = Date.now();
    store = { locations, loadedAt };
    try {
      await saveCatalogSnapshot({
        name: 'locations',
        items: locations,
        loadedAt: new Date(loadedAt),
      });
    } catch (err) {
      log.error({ err }, 'Failed to persist location catalog snapshot');
    }
    // Clear stale-warning dedup so future staleness events can warn again.
    hasWarnedStale = false;
    log.info({ count: locations.length }, 'Location data refreshed');
  } catch (err) {
    log.error({ err }, 'Failed to refresh location data — retaining previous data');
  } finally {
    isLocationRefreshing = false;
  }
}

let refreshInterval: NodeJS.Timeout | null = null;
// Dedup stale-data warnings to emit one entry per outage, not per tick.
let hasWarnedStale = false;

/** Starts the background refresh timer. Call once at startup. */
export async function startLocationRefresh(): Promise<void> {
  const log = logger.child({ module: 'data-store' });
  await warmStartLocationsFromSnapshot();
  void refreshLocations();

  const intervalMs = config.catalog.locationRefreshIntervalHours * 60 * 60 * 1000;
  const staleMs = intervalMs * 2;
  refreshInterval = setInterval(() => {
    if (!hasWarnedStale && Date.now() - store.loadedAt > staleMs && store.locations.length > 0) {
      log.warn(
        { ageMs: Date.now() - store.loadedAt, threshold: staleMs },
        'Location data is stale — refresh may be failing',
      );
      hasWarnedStale = true;
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
