import type { Context } from 'hono';
import { open, type CountryResponse, type Reader } from 'maxmind';
import { DEFAULT_REGION, regionForCountry, type GeoResponse } from '@loop/shared';

import { config } from '../config/index.js';
import { clientIpFor } from '../middleware/rate-limit.js';

// 45 days ≈ missed monthly refresh; constant since no per-deployment tuning needed (go-live-plan §T1-F)
export const GEO_DB_STALE_AFTER_DAYS = 45;

// Lazy-open GeoLite2-Country reader once; null if unconfigured or open fails (ADR 033)
let readerPromise: Promise<Reader<CountryResponse> | null> | null = null;

function geoReader(): Promise<Reader<CountryResponse> | null> {
  if (readerPromise === null) {
    const dbPath = config.catalog.geoip.databasePath;
    readerPromise = dbPath
      ? open<CountryResponse>(dbPath).catch(() => null)
      : Promise.resolve(null);
  }
  return readerPromise;
}

export interface GeoDbStatus {
  available: boolean;
  buildEpoch: string | null;
  ageDays: number | null;
  // stale=true only if configured-but-unopenable or >GEO_DB_STALE_AFTER_DAYS; false if unconfigured (dev/staging posture)
  stale: boolean;
}

// Status for /health (soft-degraded reason geo_db_stale) and boot diagnostic; recomputes age/staleness only, no re-open
export async function getGeoDbStatus(): Promise<GeoDbStatus> {
  const dbPath = config.catalog.geoip.databasePath;
  if (!dbPath) {
    // Unconfigured, not broken
    return { available: false, buildEpoch: null, ageDays: null, stale: false };
  }

  const reader = await geoReader();
  if (reader === null) {
    // Configured but failed to open: bad path, unreadable file, or deploy forgot BuildKit secrets (Dockerfile ~19-34)
    return { available: false, buildEpoch: null, ageDays: null, stale: true };
  }

  const buildEpoch = reader.metadata.buildEpoch;
  const ageDays = Math.floor((Date.now() - buildEpoch.getTime()) / (24 * 60 * 60 * 1000));
  return {
    available: true,
    buildEpoch: buildEpoch.toISOString(),
    ageDays,
    stale: ageDays > GEO_DB_STALE_AFTER_DAYS,
  };
}

// GET /api/public/geo — best-guess region from caller IP (ADR 033); unauthenticated, never-500, no-PII (ADR 020)
export async function publicGeoHandler(c: Context): Promise<Response> {
  // Varies per client; keep out of shared/CDN caches, allow short browser cache
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
