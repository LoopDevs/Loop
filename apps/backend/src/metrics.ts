// Prometheus-counter state — A4-076, A4-048, ADR 048, A-022, FT-07, NS-02
import { WEB_VITAL_NAMES, type WebVitalName } from '@loop/shared';

export { WEB_VITAL_NAMES };
export type { WebVitalName };

// A4-076: ASCII Unit Separator. Cannot appear in HTTP method, route, or status code.
export const METRIC_KEY_SEPARATOR = '\x1f';

export interface Metrics {
  rateLimitHitsTotal: number;
  requestsTotal: Map<string, number>;
  // A4-048: Status is NOT a histogram label; duration is traffic shape, not failure shape.
  requestDurationHistograms: Map<string, RequestDurationHistogram>;
  // ADR 048: Fixed 5-entry set, cardinality bounded by construction.
  webVitals: Record<WebVitalName, ValueHistogram>;
  pageViewsTotal: number;
}

export const REQUEST_DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface RequestDurationHistogram {
  buckets: number[];
  sumSeconds: number;
  count: number;
}

function emptyHistogram(): RequestDurationHistogram {
  return {
    buckets: new Array<number>(REQUEST_DURATION_BUCKETS_SECONDS.length).fill(0),
    sumSeconds: 0,
    count: 0,
  };
}

// ADR 048: Boundaries align with vitals.dev thresholds for meaningful histogram_quantile queries.
export const WEB_VITAL_BUCKETS: Record<WebVitalName, readonly number[]> = {
  LCP: [500, 1000, 1800, 2500, 3000, 4000, 6000, 10000],
  INP: [50, 100, 200, 300, 500, 800, 1500],
  CLS: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
  FCP: [500, 1000, 1800, 2500, 3000, 4500],
  TTFB: [100, 200, 400, 800, 1200, 1800, 3000],
};

export interface ValueHistogram {
  buckets: number[];
  sum: number;
  count: number;
}

function emptyValueHistogram(bucketCount: number): ValueHistogram {
  return { buckets: new Array<number>(bucketCount).fill(0), sum: 0, count: 0 };
}

function initialWebVitals(): Record<WebVitalName, ValueHistogram> {
  const entries = WEB_VITAL_NAMES.map(
    (name) => [name, emptyValueHistogram(WEB_VITAL_BUCKETS[name].length)] as const,
  );
  return Object.fromEntries(entries) as Record<WebVitalName, ValueHistogram>;
}

export const metrics: Metrics = {
  rateLimitHitsTotal: 0,
  requestsTotal: new Map(),
  requestDurationHistograms: new Map(),
  webVitals: initialWebVitals(),
  pageViewsTotal: 0,
};

export function incrementRateLimitHit(): void {
  metrics.rateLimitHitsTotal++;
}

export function incrementRequest(method: string, route: string, status: number): void {
  const key = `${method}${METRIC_KEY_SEPARATOR}${route}${METRIC_KEY_SEPARATOR}${status}`;
  metrics.requestsTotal.set(key, (metrics.requestsTotal.get(key) ?? 0) + 1);
}

// A4-048: Cumulative buckets match Prometheus convention; negative/non-finite clamped to 0.
export function recordRequestDuration(
  method: string,
  route: string,
  durationSeconds: number,
): void {
  const obs = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const key = `${method}${METRIC_KEY_SEPARATOR}${route}`;
  let hist = metrics.requestDurationHistograms.get(key);
  if (hist === undefined) {
    hist = emptyHistogram();
    metrics.requestDurationHistograms.set(key, hist);
  }
  hist.count++;
  hist.sumSeconds += obs;
  for (let i = 0; i < REQUEST_DURATION_BUCKETS_SECONDS.length; i++) {
    if (obs <= REQUEST_DURATION_BUCKETS_SECONDS[i]!) {
      hist.buckets[i]!++;
    }
  }
}

// ADR 048: Clamps negative/non-finite values to 0 defensively.
export function recordWebVital(name: WebVitalName, value: number): void {
  const obs = Number.isFinite(value) && value > 0 ? value : 0;
  const hist = metrics.webVitals[name];
  const bounds = WEB_VITAL_BUCKETS[name];
  hist.count++;
  hist.sum += obs;
  for (let i = 0; i < bounds.length; i++) {
    if (obs <= bounds[i]!) {
      hist.buckets[i]!++;
    }
  }
}

export function incrementPageView(): void {
  metrics.pageViewsTotal++;
}

// FT-07 / NS-02: Money-integrity breach registry

// FT-07 / NS-02: Separate from worker-liveness; conflating them masks breaches (NS-02).
export type MoneyIntegritySignalName =
  | 'ledger_invariant'
  | 'asset_drift'
  | 'vault_share_drift'
  | 'vault_solvency'
  | 'operator_float'
  | 'vault_float'
  | 'hot_float_backing';

export interface MoneyIntegritySignalState {
  active: boolean;
  lastEvaluatedAtMs: number | null;
}

// Lazily populated; order-preserving insertion keeps exposition deterministic.
const moneyIntegritySignals = new Map<MoneyIntegritySignalName, MoneyIntegritySignalState>();

// FT-07 / NS-02: `active` is standing state, not "did we page this tick".
export function setMoneyIntegrityBreach(
  signal: MoneyIntegritySignalName,
  active: boolean,
  now: number = Date.now(),
): void {
  const existing = moneyIntegritySignals.get(signal);
  if (existing === undefined) {
    moneyIntegritySignals.set(signal, { active, lastEvaluatedAtMs: now });
    return;
  }
  existing.active = active;
  existing.lastEvaluatedAtMs = now;
}

export function getMoneyIntegritySignals(): ReadonlyMap<
  MoneyIntegritySignalName,
  MoneyIntegritySignalState
> {
  return moneyIntegritySignals;
}

export function __resetMetricsForTests(): void {
  metrics.rateLimitHitsTotal = 0;
  metrics.requestsTotal.clear();
  metrics.requestDurationHistograms.clear();
  metrics.webVitals = initialWebVitals();
  metrics.pageViewsTotal = 0;
  moneyIntegritySignals.clear();
}
