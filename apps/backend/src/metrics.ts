/**
 * Prometheus-counter state for the Loop backend. Pulled out of
 * `app.ts` so the rate-limiter, the request-counter middleware,
 * and the `/metrics` Prometheus emitter can all reach the same
 * singleton without `app.ts` being the carrier module.
 *
 * The shape stays tiny on purpose — anything richer than counters
 * + a `Map<string, number>` belongs in a real metrics library
 * (OpenTelemetry, prom-client) which the deployment doesn't need
 * yet. We export raw state and tiny mutators rather than a class
 * because vitest can clear the singleton from a `beforeEach`
 * without dependency injection scaffolding.
 *
 * `requestsTotal` is keyed by `METHOD<US>ROUTE<US>STATUS` where
 * `<US>` is the ASCII Unit Separator character (`\x1f`). Earlier
 * versions used `:` as the delimiter, which collided with Hono's
 * parameter-route syntax (`/api/orders/:id`) — `key.split(':')`
 * then truncated the route at `:id` and assigned the parameter
 * name as the status label. The Unit Separator is a control
 * character that cannot appear in HTTP method names, route
 * patterns, or status codes, so the split is unambiguous (A4-076).
 *
 * Audit A-022 collapses unmatched routes to a constant `NOT_FOUND`
 * label so cardinality stays O(declared routes) rather than
 * O(observed URLs) — see the request-counter middleware in
 * `app.ts` for the labelling rule.
 */

/**
 * A4-076: ASCII Unit Separator. Cannot appear in any HTTP method,
 * route pattern, or status code, so it's safe as a multi-segment
 * key delimiter. Exported for the exposition handler in
 * `observability-handlers.ts` so both sides agree on the shape.
 */
export const METRIC_KEY_SEPARATOR = '\x1f';

export interface Metrics {
  /** Total 429 responses issued by the rate-limiter, fleet-wide. */
  rateLimitHitsTotal: number;
  /**
   * Counter map keyed by `METHOD<US>ROUTE<US>STATUS` (Unit
   * Separator delimiter; see `METRIC_KEY_SEPARATOR`).
   */
  requestsTotal: Map<string, number>;
  /**
   * A4-048: per-(method, route) duration histogram. Each entry is
   * keyed by `METHOD<US>ROUTE` and accumulates Prometheus-shaped
   * cumulative bucket counts plus sum + count. The exposition
   * handler emits `loop_request_duration_seconds_bucket{le=…}` /
   * `_sum` / `_count` per key so an operator can compute SLI
   * targets (p50/p95/p99 latency, error-rate-by-window) via
   * standard Prometheus queries against the scraped state. Status
   * is NOT a histogram label by design — duration distribution is
   * shape-of-traffic, not shape-of-failures; the existing
   * `loop_requests_total{status=…}` counter is the canonical
   * 5xx-rate signal.
   */
  requestDurationHistograms: Map<string, RequestDurationHistogram>;
}

/**
 * A4-048: standard Prometheus latency buckets (seconds). Cover the
 * Loop backend's interesting range — tens of ms for in-memory
 * cluster reads, hundreds of ms for upstream-proxy auth, multiple
 * seconds for slow-path payment-watcher ticks. The +Inf bucket is
 * implicit (`count` carries it).
 */
export const REQUEST_DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface RequestDurationHistogram {
  /** Cumulative bucket counts; length === REQUEST_DURATION_BUCKETS_SECONDS.length. */
  buckets: number[];
  /** Sum of observed durations in seconds. */
  sumSeconds: number;
  /** Total observation count (matches the +Inf bucket). */
  count: number;
}

function emptyHistogram(): RequestDurationHistogram {
  return {
    buckets: new Array<number>(REQUEST_DURATION_BUCKETS_SECONDS.length).fill(0),
    sumSeconds: 0,
    count: 0,
  };
}

export const metrics: Metrics = {
  rateLimitHitsTotal: 0,
  requestsTotal: new Map(),
  requestDurationHistograms: new Map(),
};

/**
 * Increments the rate-limit-hits counter. Call this from the
 * rate-limit middleware on every 429 emission so `/metrics` stays
 * accurate.
 */
export function incrementRateLimitHit(): void {
  metrics.rateLimitHitsTotal++;
}

/**
 * Increments the per-request counter for `METHOD<US>ROUTE<US>STATUS`.
 * Called by the request-counter middleware after the handler has
 * resolved, so the recorded status is final.
 */
export function incrementRequest(method: string, route: string, status: number): void {
  const key = `${method}${METRIC_KEY_SEPARATOR}${route}${METRIC_KEY_SEPARATOR}${status}`;
  metrics.requestsTotal.set(key, (metrics.requestsTotal.get(key) ?? 0) + 1);
}

/**
 * A4-048: records a request's wall-clock duration in seconds against
 * the `METHOD<US>ROUTE` histogram. Called from the request-counter
 * middleware on the same path as `incrementRequest` so every counted
 * request also contributes to the latency distribution.
 *
 * Buckets are cumulative — an observation of `0.07s` increments
 * every bucket from `0.1` upwards (the smallest bucket whose `le`
 * is ≥ the observation). This matches Prometheus's histogram
 * convention so client-side tooling (recording rules, Grafana,
 * `histogram_quantile`) reads the data correctly.
 *
 * Negative or non-finite durations are clamped to 0 — `performance.now()`
 * regressions / test-time clock skew shouldn't corrupt the bucket
 * shape.
 */
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

/**
 * Test helper: reset both counters between vitest cases. Module
 * state persists across `app.request(...)` calls inside a single
 * `vitest run`, so any test that asserts on absolute counter
 * values must zero the state first.
 */
export function __resetMetricsForTests(): void {
  metrics.rateLimitHitsTotal = 0;
  metrics.requestsTotal.clear();
  metrics.requestDurationHistograms.clear();
}
