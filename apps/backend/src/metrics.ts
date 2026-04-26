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
 * `requestsTotal` is keyed by `METHOD:ROUTE:STATUS` (e.g.
 * `GET:/api/clusters:200`). Audit A-022 collapses unmatched routes
 * to a constant `NOT_FOUND` label so cardinality stays O(declared
 * routes) rather than O(observed URLs) — see the request-counter
 * middleware in `app.ts` for the labelling rule.
 */

export interface Metrics {
  /** Total 429 responses issued by the rate-limiter, fleet-wide. */
  rateLimitHitsTotal: number;
  /** Counter map keyed by `METHOD:ROUTE:STATUS`. */
  requestsTotal: Map<string, number>;
}

export const metrics: Metrics = {
  rateLimitHitsTotal: 0,
  requestsTotal: new Map(),
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
 * Increments the per-request counter for `METHOD:ROUTE:STATUS`.
 * Called by the request-counter middleware after the handler has
 * resolved, so the recorded status is final.
 */
export function incrementRequest(method: string, route: string, status: number): void {
  const key = `${method}:${route}:${status}`;
  metrics.requestsTotal.set(key, (metrics.requestsTotal.get(key) ?? 0) + 1);
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
}
