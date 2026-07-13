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
import { WEB_VITAL_NAMES, type WebVitalName } from '@loop/shared';

export { WEB_VITAL_NAMES };
export type { WebVitalName };

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
  /**
   * ADR 048: Core Web Vitals histograms captured via
   * `POST /api/public/rum`, keyed by vital name. Fixed 5-entry set
   * (`WEB_VITAL_NAMES`) rather than a `Map` — cardinality is bounded
   * by construction, unlike the route-keyed maps above.
   */
  webVitals: Record<WebVitalName, ValueHistogram>;
  /** ADR 048: total page-view events recorded via `POST /api/public/rum`. */
  pageViewsTotal: number;
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

/**
 * ADR 048: bucket boundaries per Core Web Vital, in the vital's
 * native unit — milliseconds for LCP/INP/FCP/TTFB, an unitless
 * layout-shift score for CLS. Chosen from the vitals.dev "good" /
 * "needs improvement" / "poor" thresholds so `histogram_quantile()`
 * queries land on meaningful boundaries without an operator having to
 * memorise the Web Vitals spec.
 */
export const WEB_VITAL_BUCKETS: Record<WebVitalName, readonly number[]> = {
  LCP: [500, 1000, 1800, 2500, 3000, 4000, 6000, 10000],
  INP: [50, 100, 200, 300, 500, 800, 1500],
  CLS: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
  FCP: [500, 1000, 1800, 2500, 3000, 4500],
  TTFB: [100, 200, 400, 800, 1200, 1800, 3000],
};

/**
 * Generic value histogram — same cumulative-bucket shape as
 * `RequestDurationHistogram` but field names that don't imply
 * "seconds", since Core Web Vitals mix ms (four of them) and an
 * unitless score (CLS).
 */
export interface ValueHistogram {
  /** Cumulative bucket counts; length matches the metric's bucket-boundary array. */
  buckets: number[];
  /** Sum of observed raw values, in the metric's native unit. */
  sum: number;
  /** Total observation count (matches the +Inf bucket). */
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
 * ADR 048: records one Core Web Vital observation from
 * `POST /api/public/rum` into its fixed histogram. Negative or
 * non-finite values are clamped to 0 defensively — the handler
 * already Zod-validates the range, but this mirrors
 * `recordRequestDuration`'s belt-and-braces.
 */
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

/** ADR 048: increments the page-view counter from `POST /api/public/rum`. */
export function incrementPageView(): void {
  metrics.pageViewsTotal++;
}

// ─── Money-integrity breach registry (FT-07 / NS-02) ────────────────────────

/**
 * FT-07 / NS-02: money-integrity breach signals. The ledger /
 * drift / solvency / reconciliation watchers each own a named signal
 * here; a watcher sets `active: true` the instant a tick EVALUATES a
 * standing breach and `active: false` when a tick evaluates clean.
 * `/metrics` emits this as the `loop_money_integrity_*` gauge family
 * (`observability-handlers.ts`) so a live ledger/solvency divergence
 * is visible on the scrape surface INDEPENDENT of Discord — a
 * mis-configured or unwatched monitoring webhook can no longer render
 * a real money breach a green dashboard (the "a money breach is
 * invisible" gap).
 *
 * Deliberately separate from the worker-liveness gauges
 * (`runtime-health.ts`): a watcher tick that RAN (liveness —
 * `markWorkerTickSuccess`) and one that FOUND a breach (integrity —
 * this gauge) are two different facts, and conflating them is exactly
 * the NS-02 bug (a breach read as HEALTHY because the tick completed).
 * A watcher updates its signal ONLY on a tick that actually evaluated
 * the invariant — a lock-skipped / lease-timed-out / all-reads-failed
 * tick leaves the last-known value untouched. Because each machine
 * keeps its own copy and only the single-flight lock winner evaluates
 * per tick, a non-leading machine's value can lag; Prometheus should
 * aggregate with `max()` across the fleet (a leader's `1` cannot be
 * masked by a follower's stale `0`), same posture as the per-machine
 * `loop_worker_*` gauges.
 */
export type MoneyIntegritySignalName =
  | 'ledger_invariant'
  | 'asset_drift'
  | 'vault_share_drift'
  | 'vault_solvency'
  | 'operator_float'
  | 'vault_float';

export interface MoneyIntegritySignalState {
  /** True when the last completed evaluation of this invariant found a standing breach. */
  active: boolean;
  /** Unix ms of the last tick that actually evaluated this signal (`null` until first evaluation). */
  lastEvaluatedAtMs: number | null;
}

/**
 * Lazily populated — a signal appears once its watcher completes a
 * real evaluation (mirrors how `loop_worker_*` gauges appear only
 * once a worker starts). Order-preserving insertion keeps the
 * exposition deterministic.
 */
const moneyIntegritySignals = new Map<MoneyIntegritySignalName, MoneyIntegritySignalState>();

/**
 * Records the result of one money-integrity evaluation. Call from a
 * watcher's interval tick ONLY when the tick actually computed the
 * invariant this round (not on a lock-skip / lease-timeout). `active`
 * is the STANDING state ("is there a breach right now"), not "did we
 * page this tick" — a breach that already paged once but persists must
 * keep this gauge at 1 so the standing divergence stays visible.
 */
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

/** Read-only view for the `/metrics` exposition handler. */
export function getMoneyIntegritySignals(): ReadonlyMap<
  MoneyIntegritySignalName,
  MoneyIntegritySignalState
> {
  return moneyIntegritySignals;
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
  metrics.webVitals = initialWebVitals();
  metrics.pageViewsTotal = 0;
  moneyIntegritySignals.clear();
}
