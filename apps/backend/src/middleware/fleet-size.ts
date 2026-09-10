// Dynamic fleet-size estimator — S4-4, CF2-10
import { resolve6 } from 'node:dns/promises';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

const fleetSizeLog = logger.child({ component: 'fleet-size' });

export const FLEET_SIZE_REFRESH_MS = 30_000;

// Guards against implausible DNS record counts (misconfig/wildcard/bug) that would divide budgets to near-zero
export const FLEET_SIZE_MIN = 1;
export const FLEET_SIZE_MAX = 32;

export const FLEET_SIZE_STALE_GRACE_MS = 5 * 60 * 1000;

// CF2-10: serves max of recent samples to bias toward over-throttling during rapid scale-up
export const FLEET_SIZE_SCALEUP_BIAS_MS = 3 * FLEET_SIZE_REFRESH_MS;

let dynamicEstimate: number | null = null;
let dynamicEstimateAt = 0;
let recentSamples: Array<{ value: number; at: number }> = [];
let refreshTimer: NodeJS.Timeout | null = null;

// Defensive against missing/invalid config values (e.g. mocked in tests) to avoid NaN propagation
function staticFallbackEstimate(): number {
  const raw = config.rateLimit.machineCountEstimate;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function dynamicEstimateIsFresh(now: number): boolean {
  return dynamicEstimate !== null && now - dynamicEstimateAt <= FLEET_SIZE_STALE_GRACE_MS;
}

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

export function currentFleetSizeEstimate(now: number = Date.now()): number {
  if (dynamicEstimateIsFresh(now)) {
    return biasedDynamicEstimate(now);
  }
  return staticFallbackEstimate();
}

export function currentFleetSizeSource(now: number = Date.now()): 'dynamic' | 'static' {
  return dynamicEstimateIsFresh(now) ? 'dynamic' : 'static';
}

export async function refreshFleetSize(): Promise<void> {
  // Fly injects FLY_APP_NAME at runtime; not in config files
  const appName = process.env['FLY_APP_NAME'];
  if (!appName) {
    return;
  }
  try {
    const records = await resolve6(`${appName}.internal`);
    if (records.length === 0) {
      throw new Error('.internal AAAA query returned zero records');
    }
    dynamicEstimate = Math.min(FLEET_SIZE_MAX, Math.max(FLEET_SIZE_MIN, records.length));
    dynamicEstimateAt = Date.now();
    const biasCutoff = dynamicEstimateAt - FLEET_SIZE_SCALEUP_BIAS_MS;
    recentSamples = recentSamples.filter((sample) => sample.at >= biasCutoff);
    recentSamples.push({ value: dynamicEstimate, at: dynamicEstimateAt });
  } catch (err) {
    // Keeps last-good value; grace period logic handles fallback to static
    fleetSizeLog.debug(
      { err, appName },
      'fleet-size: .internal AAAA refresh failed; keeping last-good dynamic estimate within the grace period, then reverting to the static RATE_LIMIT_MACHINE_COUNT_ESTIMATE fallback',
    );
  }
}

// No-op in test env to prevent leaked intervals from keeping vitest runner alive
export function startFleetSizeEstimator(): void {
  if (config.env === 'test') return;
  if (refreshTimer !== null) return;
  void refreshFleetSize();
  refreshTimer = setInterval(() => void refreshFleetSize(), FLEET_SIZE_REFRESH_MS);
  refreshTimer.unref?.();
}

export function stopFleetSizeEstimator(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function __resetFleetSizeForTests(): void {
  dynamicEstimate = null;
  dynamicEstimateAt = 0;
  recentSamples = [];
}
