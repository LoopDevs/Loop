import type { Context } from 'hono';
import { open, type CountryResponse, type Reader } from 'maxmind';
import { DEFAULT_REGION, regionForCountry, type GeoResponse } from '@loop/shared';

import { env } from '../env.js';
import { clientIpFor } from '../middleware/rate-limit.js';

/**
 * Lazy-open the GeoLite2-Country reader exactly once. Resolves to null when no DB is
 * configured (MAXMIND_GEOLITE2_PATH unset) or the file can't be opened — callers then
 * fall back to the default region. The `.mmdb` is operator-provided (ADR 033).
 */
let readerPromise: Promise<Reader<CountryResponse> | null> | null = null;

function geoReader(): Promise<Reader<CountryResponse> | null> {
  if (readerPromise === null) {
    const dbPath = env.MAXMIND_GEOLITE2_PATH;
    readerPromise = dbPath
      ? open<CountryResponse>(dbPath).catch(() => null)
      : Promise.resolve(null);
  }
  return readerPromise;
}

/**
 * GET /api/public/geo — a best-guess region from the caller's IP (ADR 033), used to
 * seed the region selector before the user picks one.
 *
 * ADR 020 public surface: unauthenticated, never-500, Cache-Control set, no-PII. Only the
 * resolved country code leaves the server — the IP is never echoed or logged here. Falls
 * back to `{ countryCode: '', region: 'US' }` whenever the DB is absent or the lookup
 * fails, so the selector always works.
 */
export async function publicGeoHandler(c: Context): Promise<Response> {
  // Varies per client, so keep it out of shared/CDN caches but allow a short browser cache.
  c.header('Cache-Control', 'private, max-age=600');

  let countryCode = '';
  try {
    const reader = await geoReader();
    if (reader) {
      const result = reader.get(clientIpFor(c));
      countryCode = result?.country?.iso_code ?? '';
    }
  } catch {
    countryCode = '';
  }

  const body: GeoResponse = {
    countryCode,
    region: countryCode ? regionForCountry(countryCode) : DEFAULT_REGION,
  };
  return c.json(body);
}
