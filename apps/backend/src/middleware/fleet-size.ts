/**
 * Dynamic fleet-size estimator for the rate limiter (S4-4,
 * docs/readiness-backlog-2026-07-03.md).
 *
 * **Why not a shared store.** The obvious "real" fix for a per-machine
 * in-memory rate limiter is a shared counter (Redis/Postgres) so every
 * machine enforces the exact same budget. That was deliberately
 * rejected here: it adds a hot-path round-trip to every rate-limited
 * request, and turns a volumetric flood into a database write storm —
 * i.e. it makes the abuse case *worse*, right when it matters most.
 * ADR-040's planned Cloudflare edge is the eventual durable answer
 * (a single edge-side limiter ahead of the whole fleet); this module
 * is the interim fix that keeps today's in-memory-per-machine design
 * but makes its divisor track reality instead of a hand-set constant.
 *
 * **How it works.** Fly gives every app a private `.internal` DNS
 * zone: `<FLY_APP_NAME>.internal` resolves to one AAAA (IPv6 6PN)
 * record per currently-STARTED Machine belonging to that app,
 * fleet-wide across all regions — stopped machines are excluded
 * automatically by the platform (Fly docs, "Private Networking":
 * "All AAAA queries to Fly.io .internal domains only return 6PN
 * information for started (running) Machines"). `FLY_APP_NAME` is
 * injected into every Machine's runtime env automatically. No custom
 * DNS resolver configuration is needed inside a Fly Machine —
 * `/etc/resolv.conf` is preconfigured to point at the platform's
 * internal resolver (`fdaa::3`) at boot, so Node's stock
 * `dns.promises.resolve6` works unmodified; a `dns.promises.Resolver`
 * with `setServers(['fdaa::3'])` is documented by Fly as a fallback
 * for "unusual file system layout" cases but isn't needed here.
 *
 * A background interval (not per-request — DNS is never on the
 * request path) refreshes the count every `FLEET_SIZE_REFRESH_MS` and
 * caches it. `currentFleetSizeEstimate()` is the single read call
 * `rate-limit.ts` uses to compute the effective per-machine budget on
 * every request.
 *
 * **Failure handling — the asymmetry that matters.** A DNS failure
 * must never make limits LOOSER than the static estimate (that's the
 * unsafe direction — it's exactly the failure mode this fix exists to
 * close). So: on a refresh failure the last-known-good dynamic value
 * keeps being served for `FLEET_SIZE_STALE_GRACE_MS` (a transient DNS
 * blip shouldn't cause a visible behaviour change), and only once that
 * grace period elapses without a successful refresh does the estimator
 * fall back to the static `RATE_LIMIT_MACHINE_COUNT_ESTIMATE`. The
 * fallback is deliberately the STATIC estimate, not e.g. "1" — the
 * static value is still an operator-supplied floor, just a
 * conservative/stale one.
 *
 * **Why prefer dynamic over `max(dynamic, static)`.** A shrunk fleet
 * (e.g. autoscale down to 1 machine) means dividing by a too-high
 * static estimate makes limits tighter than configured — safe,
 * annoying at worst. A grown fleet (autoscale up under load) means
 * dividing by a too-low static estimate makes limits looser than
 * configured — unsafe, and exactly the spike you want limits tight
 * for. The dynamic DNS-derived count is correct in BOTH directions, so
 * it should always win when fresh; `max(dynamic, static)` would
 * needlessly re-introduce the "too tight when the fleet shrinks"
 * behaviour the static estimate already had, for no safety benefit.
 *
 * **Rapid scale-up bias (CF2-10; transient recorded auth-review
 * 2026-07-09, closed 2026-07-13).** The "never looser than the static
 * estimate" guarantee above is proven for the DNS-FAILURE path. The
 * success path once had a bounded UNDERCOUNT window: a refresh caches
 * the count at N, and machines started in the following
 * `FLEET_SIZE_REFRESH_MS` were not reflected until the next tick — so
 * during a rapid scale-up the divisor could briefly be lower than the
 * true fleet (loosest case: the tick sampling a trough right before a
 * spike), letting aggregate throughput transiently exceed the global
 * budget — the unsafe direction. Closed by serving the MAXIMUM of the
 * successful refreshes seen within `FLEET_SIZE_SCALEUP_BIAS_MS` rather
 * than only the latest one (see that constant): a transient trough now
 * errs toward OVER-throttling (safe), while a genuine sustained
 * downscale still settles onto the true count once the high-water
 * sample ages out of that short window. The OTP routes' independent
 * per-email lockout (threat-model B5) remains an additional bound.
 * Recorded in docs/threat-model.md CF2-10.
 */
import { resolve6 } from 'node:dns/promises';
import { env } from '../env.js';
import { logger } from '../logger.js';

const fleetSizeLog = logger.child({ component: 'fleet-size' });

/** How often the background tick re-queries `.internal` DNS. */
export const FLEET_SIZE_REFRESH_MS = 30_000;

/**
 * Sane bounds on the machine count we'll ever divide by. `1` is the
 * obvious floor (never divide toward 0). `32` is a generous ceiling —
 * far past any fleet size this app runs today — guarding against a
 * DNS response (misconfiguration, a shared/wildcard zone, a platform
 * bug) producing an implausible record count that would divide every
 * budget down to near-zero and effectively lock out real traffic.
 */
export const FLEET_SIZE_MIN = 1;
export const FLEET_SIZE_MAX = 32;

/**
 * How long a last-known-good dynamic estimate is trusted after the
 * refresh that produced it, before reverting to the static fallback.
 * Long enough to ride out a transient DNS hiccup (several missed
 * `FLEET_SIZE_REFRESH_MS` ticks) without flapping to the static
 * estimate; short enough that a genuine sustained DNS outage doesn't
 * leave a stale count in effect indefinitely.
 */
export const FLEET_SIZE_STALE_GRACE_MS = 5 * 60 * 1000;

/**
 * Scale-up bias window (CF2-10). A single refresh is a point-in-time
 * snapshot, so a machine that starts between ticks isn't counted until
 * the next tick — the divisor can briefly UNDERCOUNT a growing fleet and
 * let aggregate throughput exceed the global budget (the unsafe
 * direction; see the "Rapid scale-up bias" module note). To bias a stale
 * estimate toward OVER-throttling instead, `currentFleetSizeEstimate`
 * serves the MAXIMUM of the successful refreshes seen in the last
 * `FLEET_SIZE_SCALEUP_BIAS_MS`, not just the most recent one: a transient
 * trough (an autoscale dip, or the tick landing in the trough right
 * before a spike — the loosest documented case) is ignored for this long,
 * so the divisor holds the recent high-water mark and errs tight. A
 * GENUINE sustained downscale still takes effect once the higher samples
 * age out of this window, so the bias only ever makes limits tighter for
 * a bounded interval, never looser, and never overrides the grace-period
 * / static-fallback logic (which gate on the LATEST sample's age).
 *
 * Sized at a small multiple of the refresh interval: long enough to
 * bridge a multi-tick trough plus the tick that first observes the spike,
 * short enough that a real downscale isn't over-throttled for more than
 * roughly a minute and a half.
 */
export const FLEET_SIZE_SCALEUP_BIAS_MS = 3 * FLEET_SIZE_REFRESH_MS;

let dynamicEstimate: number | null = null;
let dynamicEstimateAt = 0;
/**
 * Recent successful-refresh samples `{ value, at }`, newest last, pruned
 * to the `FLEET_SIZE_SCALEUP_BIAS_MS` window on every write. Backs the
 * windowed-max scale-up bias above; in production this holds only a
 * handful of entries (window / refresh interval).
 */
let recentSamples: Array<{ value: number; at: number }> = [];
let refreshTimer: NodeJS.Timeout | null = null;

/**
 * The pre-existing static-divisor behaviour (CF2-10), unchanged:
 * defensive against a missing/invalid env value (some test suites
 * mock `env.js` with a hand-picked field subset — see the comment on
 * this same guard in `rate-limit.ts`'s history) so a bad value falls
 * back to 1 (no division) rather than propagating `NaN`.
 */
function staticFallbackEstimate(): number {
  const raw = env.RATE_LIMIT_MACHINE_COUNT_ESTIMATE;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function dynamicEstimateIsFresh(now: number): boolean {
  return dynamicEstimate !== null && now - dynamicEstimateAt <= FLEET_SIZE_STALE_GRACE_MS;
}

/**
 * The dynamic estimate to serve while fresh: the MAXIMUM record count
 * over the successful refreshes within `FLEET_SIZE_SCALEUP_BIAS_MS` of
 * `now` (the scale-up bias, CF2-10) — never below the latest cached
 * value, which is the floor when no other sample is in-window. Every
 * stored sample is already clamped to `[FLEET_SIZE_MIN, FLEET_SIZE_MAX]`,
 * so the max is too. Only called when `dynamicEstimateIsFresh` holds, so
 * `dynamicEstimate` is non-null.
 */
function biasedDynamicEstimate(now: number): number {
  let max = dynamicEstimate as number;
  const cutoff = now - FLEET_SIZE_SCALEUP_BIAS_MS;
  for (const sample of recentSamples) {
    if (sample.at >= cutoff && sample.value > max) {
      max = sample.value;
    }
  }
  return max;
}

/**
 * The value `rate-limit.ts` divides every configured per-route budget
 * by. Never throws. Prefers the dynamic DNS-derived estimate whenever
 * it's fresh (see module doc for why), biased up to the recent
 * high-water mark to stay conservative through a rapid scale-up
 * (CF2-10); otherwise falls back to the static
 * `RATE_LIMIT_MACHINE_COUNT_ESTIMATE`.
 */
export function currentFleetSizeEstimate(now: number = Date.now()): number {
  if (dynamicEstimateIsFresh(now)) {
    return biasedDynamicEstimate(now);
  }
  return staticFallbackEstimate();
}

/** Which source `currentFleetSizeEstimate()` is currently drawing from — exposed for `/health`. */
export function currentFleetSizeSource(now: number = Date.now()): 'dynamic' | 'static' {
  return dynamicEstimateIsFresh(now) ? 'dynamic' : 'static';
}

/**
 * Single refresh tick: resolve `<FLY_APP_NAME>.internal`, count the
 * AAAA records, clamp, cache. Exported for tests that want to drive a
 * tick directly rather than waiting on the interval.
 *
 * Deliberately never throws into the caller — both the "no
 * FLY_APP_NAME" and "DNS failed" paths are ordinary, expected
 * outcomes (non-Fly host; transient resolver hiccup) and are handled
 * by leaving `dynamicEstimate` as-is, letting `currentFleetSizeEstimate`'s
 * grace-period logic decide what to serve.
 */
export async function refreshFleetSize(): Promise<void> {
  const appName = env.FLY_APP_NAME;
  if (!appName) {
    // Not running on Fly (local dev, CI, another host) — there's no
    // `.internal` zone to query. Leave any prior dynamic value alone;
    // it will age out via the grace period exactly like a DNS failure
    // would, which is the correct behaviour if FLY_APP_NAME is ever
    // unset mid-process (it shouldn't be, but this keeps the function
    // total either way).
    return;
  }
  try {
    const records = await resolve6(`${appName}.internal`);
    if (records.length === 0) {
      throw new Error('.internal AAAA query returned zero records');
    }
    dynamicEstimate = Math.min(FLEET_SIZE_MAX, Math.max(FLEET_SIZE_MIN, records.length));
    dynamicEstimateAt = Date.now();
    // Feed the scale-up bias (CF2-10): retain this sample and drop any
    // now older than the bias window, so `currentFleetSizeEstimate` can
    // serve the recent high-water mark and never undercount a fleet that
    // dipped right before a spike.
    const biasCutoff = dynamicEstimateAt - FLEET_SIZE_SCALEUP_BIAS_MS;
    recentSamples = recentSamples.filter((sample) => sample.at >= biasCutoff);
    recentSamples.push({ value: dynamicEstimate, at: dynamicEstimateAt });
  } catch (err) {
    // Keep the last-good value (if any) in place; currentFleetSizeEstimate's
    // grace period decides when it's too old to trust. A single failed
    // tick must never make limits looser than the static fallback, and
    // it doesn't — it just stops advancing dynamicEstimateAt.
    fleetSizeLog.debug(
      { err, appName },
      'fleet-size: .internal AAAA refresh failed; keeping last-good dynamic estimate within the grace period, then reverting to the static RATE_LIMIT_MACHINE_COUNT_ESTIMATE fallback',
    );
  }
}

/**
 * Starts the background refresh interval. Always-on (not gated behind
 * `LOOP_WORKERS_ENABLED`) because every machine enforces rate limits,
 * not just the ones running the Loop-native order workers — unlike
 * those workers, this isn't optional infrastructure. No-op in
 * `NODE_ENV=test` (vitest imports `app.ts` repeatedly across files; a
 * leaked interval keeps the runner alive, same reasoning as
 * `startCleanupInterval` in `cleanup.ts`). `.unref()`'d so a process
 * that exits without calling `stopFleetSizeEstimator()` can still shut
 * down cleanly.
 */
export function startFleetSizeEstimator(): void {
  if (env.NODE_ENV === 'test') return;
  if (refreshTimer !== null) return;
  // Kick off an immediate first refresh rather than waiting a full
  // interval for the first real estimate — otherwise every fresh boot
  // runs on the static fallback for up to FLEET_SIZE_REFRESH_MS.
  void refreshFleetSize();
  refreshTimer = setInterval(() => void refreshFleetSize(), FLEET_SIZE_REFRESH_MS);
  refreshTimer.unref?.();
}

/** Stops the refresh interval. Intended for graceful shutdown (mirrors `stopCleanupInterval`). */
export function stopFleetSizeEstimator(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test helper: reset module state between vitest cases. */
export function __resetFleetSizeForTests(): void {
  dynamicEstimate = null;
  dynamicEstimateAt = 0;
  recentSamples = [];
}
