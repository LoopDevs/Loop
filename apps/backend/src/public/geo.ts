import type { Context } from 'hono';
import { open, type CountryResponse, type Reader } from 'maxmind';
import { DEFAULT_REGION, regionForCountry, type GeoResponse } from '@loop/shared';

import { env } from '../env.js';
import { clientIpFor } from '../middleware/rate-limit.js';

/**
 * MaxMind ships GeoLite2-Country weekly (docs/deployment.md §GeoLite2). The
 * `.mmdb` only refreshes when a deploy remembers the two `--build-secret`
 * flags — a forgotten refresh degrades the `/` geo-redirect silently
 * (falls back to the US default, ADR 034) with no signal anywhere. 45 days
 * is roughly a missed monthly refresh cycle; a code constant rather than an
 * env var since nobody needs to tune this per deployment (go-live-plan
 * §T1-F).
 */
export const GEO_DB_STALE_AFTER_DAYS = 45;

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

export interface GeoDbStatus {
  /** True once a `.mmdb` has been opened successfully. */
  available: boolean;
  /** ISO-8601 build timestamp from the `.mmdb`'s own metadata, null when unavailable. */
  buildEpoch: string | null;
  /** Age of the `.mmdb` build in whole days, null when unavailable. */
  ageDays: number | null;
  /**
   * True when the DB is either stale (built more than
   * `GEO_DB_STALE_AFTER_DAYS` ago) or configured-but-unopenable. False when
   * fresh, AND false when `MAXMIND_GEOLITE2_PATH` was never set at all —
   * that's a deliberate "geo unconfigured" dev/staging posture, not a
   * degradation, so it must not permanently soft-degrade `/health` (mirrors
   * how other optional-feature env vars — e.g. `LOOP_WALLET_PROVIDER`,
   * `LOOP_STELLAR_DEPOSIT_ADDRESS` — distinguish "off" from "broken").
   */
  stale: boolean;
}

/**
 * Current status of the operator-provided GeoLite2-Country `.mmdb`, used by
 * `/health` (soft-degraded reason `geo_db_stale`) and the boot-time
 * diagnostic in `index.ts`. The underlying reader-open is memoized via
 * `geoReader()` above — this recomputes only the cheap age/staleness check
 * against `reader.metadata.buildEpoch` on every call, no re-open, no I/O.
 */
export async function getGeoDbStatus(): Promise<GeoDbStatus> {
  const dbPath = env.MAXMIND_GEOLITE2_PATH;
  if (!dbPath) {
    // Unconfigured, not broken — see the `stale` doc comment above.
    return { available: false, buildEpoch: null, ageDays: null, stale: false };
  }

  const reader = await geoReader();
  if (reader === null) {
    // Configured but failed to open: bad path, unreadable file, or a
    // deploy that forgot the BuildKit secrets (Dockerfile still sets
    // MAXMIND_GEOLITE2_PATH regardless of whether the download succeeded —
    // see apps/backend/Dockerfile ~19-34). This IS a misconfiguration
    // signal, unlike the unset-var case above.
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
