/**
 * `/health` handler + the rolling-window flap-damping state that
 * gates Discord notifies. Pulled out of `app.ts` so the
 * hysteresis policy + the upstream-probe cache + the notify
 * cooldown all live in one file.
 *
 * Why two layers of throttling here:
 *
 * 1. **Rolling-window streak detection** — switched from a
 *    consecutive-streak detector after a prod flap: a marginally-
 *    slow CTX `/status` probe (near the 5s timeout) would produce
 *    alternating DOWN/UP readings; the streak detector caught
 *    every one as a transition. The window approach tolerates a
 *    few bad probes without flipping — the signal has to be
 *    persistent. Asymmetric thresholds preserve the original
 *    behaviour: easier to fall *into* degraded (5 of 10 bad
 *    probes ≈ 2-3 minutes during real outages), harder to claim
 *    *back* to healthy (8 of 10 good probes) so a marginally-
 *    slow upstream doesn't bounce us before the underlying issue
 *    settles.
 * 2. **Notify cooldown** (30 minutes) — belt-and-braces second
 *    layer so a sustained hour-long outage emitting repeated
 *    healthy↔degraded transitions (genuine ones, each with a
 *    streak) still keeps the monitoring channel readable. Raw
 *    `/health` state is always queryable so ops still has ground
 *    truth.
 *
 * The upstream-probe cache (10s TTL) keeps `/health` cheap:
 * `/health` is unauthenticated and unrate-limited (Fly probes
 * every 15s, k8s-ish liveness patterns do similar). Without the
 * cache every external call — including from an attacker
 * spamming the endpoint — would trigger a fresh outbound fetch to
 * CTX, both generating upstream load we don't want to be
 * responsible for and burning our local socket budget. 10s is
 * shorter than the Fly probe interval so the cached value is
 * always the one from the last probe.
 */
import type { Context } from 'hono';
import { env } from './env.js';
import { logger } from './logger.js';
import { getLocations, isLocationLoading } from './clustering/data-store.js';
import { getMerchants } from './merchants/sync.js';
import { upstreamUrl } from './upstream.js';
import { notifyHealthChange } from './discord.js';

const healthLog = logger.child({ component: 'health' });

let lastHealthStatus: 'healthy' | 'degraded' | null = null;
const HEALTH_WINDOW_SIZE = 10;
const HEALTH_FLIP_TO_DEGRADED_THRESHOLD = 5;
const HEALTH_FLIP_TO_HEALTHY_THRESHOLD = 8;
const healthReadings: Array<'healthy' | 'degraded'> = [];

const HEALTH_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
let lastHealthNotifyAt = 0;

const UPSTREAM_PROBE_TTL_MS = 10_000;
/**
 * Probe timeout. Intentionally LONGER than the Fly healthcheck
 * timeout (5s) — the Fly probe times out and retries its own
 * schedule, but the probe result we care about here is whether
 * upstream *eventually* responds within a few seconds. Keeping
 * this at 5s was producing degraded readings whenever CTX
 * `/status` p95 latency spiked into the 4.5–7s band (common
 * under load). 8s covers that band without stretching so far
 * that a genuinely down upstream waits forever.
 */
const UPSTREAM_PROBE_TIMEOUT_MS = 8_000;
let upstreamProbeCache: { reachable: boolean; at: number } | null = null;
let upstreamProbeInFlight: Promise<boolean> | null = null;

/**
 * Throttle wrapper on top of `notifyHealthChange`. The streak
 * gating absorbs per-probe jitter; this is the second layer.
 */
function maybeNotifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  const now = Date.now();
  if (now - lastHealthNotifyAt < HEALTH_NOTIFY_COOLDOWN_MS) return;
  lastHealthNotifyAt = now;
  notifyHealthChange(status, details);
}

async function probeUpstream(): Promise<boolean> {
  const now = Date.now();
  if (upstreamProbeCache !== null && now - upstreamProbeCache.at < UPSTREAM_PROBE_TTL_MS) {
    return upstreamProbeCache.reachable;
  }
  // Coalesce concurrent probes — a burst of /health requests that
  // arrive within the TTL window should share one outbound fetch,
  // not each fire their own.
  if (upstreamProbeInFlight !== null) return upstreamProbeInFlight;

  upstreamProbeInFlight = (async () => {
    let reachable = true;
    try {
      // Deliberately bare `fetch`, NOT `getUpstreamCircuit('status').fetch`.
      // /health needs to detect upstream *recovery*; if we routed
      // through a circuit breaker that was open (because a different
      // endpoint just failed, for example), the probe would short-
      // circuit to CircuitOpenError and /health would keep reporting
      // `degraded` long after upstream came back. See
      // `docs/architecture.md §Circuit breaker` — this is the one
      // documented exception to the AGENTS.md "never bare fetch" rule
      // for upstream calls.
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

export async function healthHandler(c: Context): Promise<Response> {
  const { locations, loadedAt: locLoadedAt } = getLocations();
  const { merchants, loadedAt: merLoadedAt } = getMerchants();

  const now = Date.now();
  const merchantStaleMs = env.REFRESH_INTERVAL_HOURS * 2 * 60 * 60 * 1000;
  const locationStaleMs = env.LOCATION_REFRESH_INTERVAL_HOURS * 2 * 60 * 60 * 1000;
  const merchantsStale = now - merLoadedAt > merchantStaleMs;
  const locationsStale = now - locLoadedAt > locationStaleMs;

  const upstreamReachable = await probeUpstream();

  const degraded = merchantsStale || locationsStale || !upstreamReachable;

  // Raw reading → rolling window. Keep the last N readings, flip
  // when a supermajority agrees. Shifts out the oldest reading
  // once the window is full so the detector always reflects
  // recent state.
  const rawReading: 'degraded' | 'healthy' = degraded ? 'degraded' : 'healthy';
  healthReadings.push(rawReading);
  if (healthReadings.length > HEALTH_WINDOW_SIZE) healthReadings.shift();

  const degradedInWindow = healthReadings.filter((r) => r === 'degraded').length;
  const healthyInWindow = healthReadings.length - degradedInWindow;

  // Bootstrap on first /health hit — no window gating yet because
  // we have no prior state to flip against. After this one-shot
  // seed, every subsequent transition has to clear the threshold.
  if (lastHealthStatus === null) {
    lastHealthStatus = rawReading;
  } else if (
    lastHealthStatus === 'healthy' &&
    degradedInWindow >= HEALTH_FLIP_TO_DEGRADED_THRESHOLD
  ) {
    lastHealthStatus = 'degraded';
    const why = `Merchants stale: ${merchantsStale}, Locations stale: ${locationsStale}, Upstream: ${upstreamReachable ? 'up' : 'DOWN'}`;
    healthLog.warn(
      {
        degradedInWindow,
        healthyInWindow,
        windowSize: healthReadings.length,
        merchantsStale,
        locationsStale,
        upstreamReachable,
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

  // /health reports live service state (merchant/location
  // staleness, upstream reachability). A CDN in front caching
  // this would serve "healthy" for the cache TTL after upstream
  // went down — masking outages from external probes. `no-store`
  // is the safe default even though Fly's own probe path doesn't
  // cache.
  c.header('Cache-Control', 'no-store');
  return c.json({
    status: degraded ? 'degraded' : 'healthy',
    locationCount: locations.length,
    locationsLoading: isLocationLoading(),
    merchantCount: merchants.length,
    merchantsLoadedAt: new Date(merLoadedAt).toISOString(),
    locationsLoadedAt: new Date(locLoadedAt).toISOString(),
    merchantsStale,
    locationsStale,
    upstreamReachable,
  });
}

/**
 * Test helper: clear the /health upstream-probe cache + the
 * hysteresis state. The handler caches the upstream fetch result
 * for 10s so external spammers don't generate outbound traffic
 * proportional to inbound. Tests that simulate upstream
 * reachability changes need to invalidate the cache + the
 * rolling-window readings between cases to observe the
 * transition.
 */
export function __resetHealthProbeCacheForTests(): void {
  upstreamProbeCache = null;
  upstreamProbeInFlight = null;
  lastHealthStatus = null;
  healthReadings.length = 0;
  lastHealthNotifyAt = 0;
}

/**
 * Test seam: resets only the upstream probe cache (not the
 * hysteresis streaks or notify cooldown). Used by flap-damping
 * tests that need to force a fresh probe between /health calls
 * while preserving the accumulated streak state — the whole point
 * the tests are verifying.
 */
export function __resetUpstreamProbeCacheOnlyForTests(): void {
  upstreamProbeCache = null;
  upstreamProbeInFlight = null;
}
