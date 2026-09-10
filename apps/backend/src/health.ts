// /health handler + flap-damping state — CONV-WATCH-02, A4-034, A4-035, A4-073, B-5, S4-4, BK-healthrecon
import type { Context } from 'hono';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { db } from './db/client.js';
import { getLocations, isLocationLoading } from './clustering/data-store.js';
import { getMerchants } from './merchants/sync.js';
import { MERCHANT_REFRESH_INTERVAL_MS } from './merchants/sync-interval.js';
import { getCtxWsStatus, getCtxWsSubscribedTopics } from './ctx/ws-events.js';
import { getRuntimeHealthSnapshot } from './runtime-health.js';
import { upstreamUrl } from './upstream.js';
import { notifyGeoDbStale } from './discord.js';
import { sendWebhook, GREEN, ORANGE, DESCRIPTION_MAX, truncate } from './discord/shared.js';
import { applyBinaryWatchdogAlert } from './discord/watchdog-alert.js';
import { getCtxApiHealth } from './ctx/api-fetch.js';
import { getGeoDbStatus, GEO_DB_STALE_AFTER_DAYS } from './public/geo.js';
import { currentFleetSizeEstimate, currentFleetSizeSource } from './middleware/fleet-size.js';
import { probeGateAllows } from './middleware/probe-gate.js';

const healthLog = logger.child({ component: 'health' });

let lastHealthStatus: 'healthy' | 'degraded' | null = null;
const HEALTH_WINDOW_SIZE = 10;
const HEALTH_FLIP_TO_DEGRADED_THRESHOLD = 5;
const HEALTH_FLIP_TO_HEALTHY_THRESHOLD = 8;
const healthReadings: Array<'healthy' | 'degraded'> = [];

// CONV-WATCH-02: fleet-wide fire-once gate for health-change pages
const HEALTH_CHANGE_WATCHDOG_NAME = 'health-change';

// GeoLite2 staleness is a slow-changing condition; 7-day cooldown matches MaxMind refresh cadence
const GEO_DB_NOTIFY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
let lastGeoDbNotifyAt = 0;

function maybeNotifyGeoDbStale(buildEpoch: string | null, ageDays: number | null): void {
  const now = Date.now();
  if (now - lastGeoDbNotifyAt < GEO_DB_NOTIFY_COOLDOWN_MS) return;
  lastGeoDbNotifyAt = now;
  notifyGeoDbStale({ buildEpoch, ageDays, thresholdDays: GEO_DB_STALE_AFTER_DAYS });
}

const UPSTREAM_PROBE_TTL_MS = 10_000;
// 8s timeout covers CTX /status p95 latency spikes (4.5–7s) without masking genuine outages
const UPSTREAM_PROBE_TIMEOUT_MS = 8_000;
let upstreamProbeCache: { reachable: boolean; at: number } | null = null;
let upstreamProbeInFlight: Promise<boolean> | null = null;

// Returns delivery status so the fleet-wide gate latches alert_active only on real delivery
function sendHealthChangeWebhook(
  status: 'healthy' | 'degraded',
  details: string,
): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: truncate(details, DESCRIPTION_MAX),
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

// CONV-WATCH-02: routes health-change pages through fleet-wide dedup gate to prevent N-machines-N-pages
export function routeHealthChangeNotify(
  status: 'healthy' | 'degraded',
  details: string,
): Promise<boolean> {
  return applyBinaryWatchdogAlert({
    watchdogName: HEALTH_CHANGE_WATCHDOG_NAME,
    shouldBeActive: status === 'degraded',
    notifyActive: () => sendHealthChangeWebhook('degraded', details),
    notifyRecovered: () => sendHealthChangeWebhook('healthy', 'All systems operational'),
  });
}

// Fire-and-forget wrapper; falls back to un-deduped send if the gate's DB read fails (DB outage is the incident)
function maybeNotifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void routeHealthChangeNotify(status, details).catch((err: unknown) => {
    healthLog.warn(
      { err },
      'Health-change fleet dedup gate failed (DB likely the incident) — sending an un-deduped fallback page so the incident still surfaces',
    );
    void sendHealthChangeWebhook(status, details);
  });
}

// A4-034: lightweight Postgres readiness probe; A4-035 / A4-073: 503 on failure
const DB_PROBE_TIMEOUT_MS = 3_000;
let dbProbeCache: { reachable: boolean; at: number } | null = null;
let dbProbeInFlight: Promise<boolean> | null = null;

async function probeDb(): Promise<boolean> {
  const now = Date.now();
  if (dbProbeCache !== null && now - dbProbeCache.at < UPSTREAM_PROBE_TTL_MS) {
    return dbProbeCache.reachable;
  }
  if (dbProbeInFlight !== null) return dbProbeInFlight;

  dbProbeInFlight = (async () => {
    let reachable = true;
    try {
      await Promise.race([
        db.collection('users').count({}),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('db probe timeout')), DB_PROBE_TIMEOUT_MS).unref?.(),
        ),
      ]);
    } catch {
      reachable = false;
    }
    dbProbeCache = { reachable, at: Date.now() };
    dbProbeInFlight = null;
    return reachable;
  })();
  return dbProbeInFlight;
}

export function __resetDbProbeCacheForTests(): void {
  dbProbeCache = null;
  dbProbeInFlight = null;
}

async function probeUpstream(): Promise<boolean> {
  const now = Date.now();
  if (upstreamProbeCache !== null && now - upstreamProbeCache.at < UPSTREAM_PROBE_TTL_MS) {
    return upstreamProbeCache.reachable;
  }
  if (upstreamProbeInFlight !== null) return upstreamProbeInFlight;

  upstreamProbeInFlight = (async () => {
    let reachable = true;
    try {
      const res = await fetch(upstreamUrl('/status'), {
        signal: AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    upstreamProbeCache = { reachable, at: Date.now() };
    upstreamProbeInFlight = null;
    return reachable;
  })();
  return upstreamProbeInFlight;
}

// B-5: single source of truth for freshness thresholds to prevent drift between /health and /metrics
export function merchantCatalogStaleAfterMs(): number {
  return MERCHANT_REFRESH_INTERVAL_MS * 2;
}

export function locationCatalogStaleAfterMs(): number {
  return config.catalog.locationRefreshIntervalHours * 2 * 60 * 60 * 1000;
}

export async function healthHandler(c: Context): Promise<Response> {
  const { locations, loadedAt: locLoadedAt } = getLocations();
  const { merchants, loadedAt: merLoadedAt } = getMerchants();

  const now = Date.now();
  const merchantStaleMs = merchantCatalogStaleAfterMs();
  const locationStaleMs = locationCatalogStaleAfterMs();
  const merchantsStale = now - merLoadedAt > merchantStaleMs;
  const locationsStale = now - locLoadedAt > locationStaleMs;

  const [upstreamReachable, databaseReachable, geoDbStatus] = await Promise.all([
    probeUpstream(),
    probeDb(),
    getGeoDbStatus(),
  ]);
  const runtime = getRuntimeHealthSnapshot();

  // Retained for response-shape stability; ctxApiDown never true as CTX-upstream breaker is gone
  const ctxApiHealth = getCtxApiHealth();
  const ctxApiDown = ctxApiHealth.configured && ctxApiHealth.state === 'open';

  // Two-tier degradation: critical (503, Fly cycles) vs soft (200, visible in monitoring)
  const criticalDegraded = !databaseReachable || runtime.degraded;
  const softDegraded =
    merchantsStale || locationsStale || !upstreamReachable || ctxApiDown || geoDbStatus.stale;
  const degraded = criticalDegraded || softDegraded;

  // Only critical degradation contributes to the notify-window to prevent Discord paging on upstream blips
  const rawReading: 'degraded' | 'healthy' = criticalDegraded ? 'degraded' : 'healthy';
  healthReadings.push(rawReading);
  if (healthReadings.length > HEALTH_WINDOW_SIZE) healthReadings.shift();

  const degradedInWindow = healthReadings.filter((r) => r === 'degraded').length;
  const healthyInWindow = healthReadings.length - degradedInWindow;

  if (lastHealthStatus === null) {
    lastHealthStatus = rawReading;
  } else if (
    lastHealthStatus === 'healthy' &&
    degradedInWindow >= HEALTH_FLIP_TO_DEGRADED_THRESHOLD
  ) {
    lastHealthStatus = 'degraded';
    const runtimeReasons: string[] = [];
    if (runtime.otpDelivery.degraded) runtimeReasons.push('otp_delivery');
    const degradedWorkers = runtime.workers
      .filter((worker) => worker.degraded)
      .map((worker) => worker.name);
    if (degradedWorkers.length > 0) {
      runtimeReasons.push(`workers=${degradedWorkers.join(',')}`);
    }
    const why = [
      `Merchants stale: ${merchantsStale}`,
      `Locations stale: ${locationsStale}`,
      `Upstream: ${upstreamReachable ? 'up' : 'DOWN'}`,
      `Runtime: ${runtimeReasons.length > 0 ? runtimeReasons.join('; ') : 'ok'}`,
    ].join(', ');
    healthLog.warn(
      {
        degradedInWindow,
        healthyInWindow,
        windowSize: healthReadings.length,
        merchantsStale,
        locationsStale,
        upstreamReachable,
        runtimeDegraded: runtime.degraded,
      },
      'Health flip → degraded',
    );
    maybeNotifyHealthChange('degraded', why);
  } else if (
    lastHealthStatus === 'degraded' &&
    healthyInWindow >= HEALTH_FLIP_TO_HEALTHY_THRESHOLD
  ) {
    lastHealthStatus = 'healthy';
    healthLog.info(
      {
        degradedInWindow,
        healthyInWindow,
        windowSize: healthReadings.length,
      },
      'Health flip → healthy',
    );
    maybeNotifyHealthChange('healthy', 'All systems operational');
  }

  // no-store prevents CDN from masking outages by serving stale "healthy" status
  c.header('Cache-Control', 'no-store');
  const httpStatus = criticalDegraded ? 503 : 200;
  const softDegradedReasons: string[] = [];
  if (merchantsStale) softDegradedReasons.push('merchants_stale');
  if (locationsStale) softDegradedReasons.push('locations_stale');
  if (!upstreamReachable) softDegradedReasons.push('upstream_unreachable');
  if (ctxApiDown) softDegradedReasons.push('ctx_api_down');
  if (geoDbStatus.stale) {
    softDegradedReasons.push('geo_db_stale');
    // go-live-plan §T1-F: pages on GeoLite2 staleness as silent config-drift
    maybeNotifyGeoDbStale(geoDbStatus.buildEpoch, geoDbStatus.ageDays);
  }

  // BK-healthrecon: gates detailed body behind ops-probe bearer to hide reconnaissance surface from unauthenticated callers
  c.header('Vary', 'Authorization');
  if (!probeGateAllows(c, config.observability.metrics.bearerToken)) {
    return c.json({ status: degraded ? 'degraded' : 'healthy' }, httpStatus);
  }
  return c.json(
    {
      status: degraded ? 'degraded' : 'healthy',
      locationCount: locations.length,
      locationsLoading: isLocationLoading(),
      merchantCount: merchants.length,
      merchantsLoadedAt: new Date(merLoadedAt).toISOString(),
      locationsLoadedAt: new Date(locLoadedAt).toISOString(),
      merchantsStale,
      locationsStale,
      ctxWs: getCtxWsStatus(),
      ctxWsTopics: getCtxWsSubscribedTopics(),
      // go-live-plan §T1-F: geoDbStale is false when unconfigured; see GeoDbStatus.stale
      geoDbStale: geoDbStatus.stale,
      geoDbBuildEpoch: geoDbStatus.buildEpoch,
      // S4-4: current divisor for rate limiter fleet-wide budget conversion
      rateLimitFleetEstimate: currentFleetSizeEstimate(),
      rateLimitFleetEstimateSource: currentFleetSizeSource(),
      upstreamReachable,
      // A4-034: DB readiness component
      databaseReachable,
      // Constant now — kept because the admin CTX status indicator reads this shape
      ctxApi: ctxApiHealth,
      ctxApiDown,
      criticalDegraded,
      softDegraded,
      softDegradedReasons,
      otpDelivery: runtime.otpDelivery,
      workers: runtime.workers,
    },
    httpStatus,
  );
}

export function __resetHealthProbeCacheForTests(): void {
  upstreamProbeCache = null;
  upstreamProbeInFlight = null;
  dbProbeCache = null;
  dbProbeInFlight = null;
  lastHealthStatus = null;
  healthReadings.length = 0;
  lastGeoDbNotifyAt = 0;
}

export function __resetUpstreamProbeCacheOnlyForTests(): void {
  upstreamProbeCache = null;
  upstreamProbeInFlight = null;
}
