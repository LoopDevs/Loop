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
 * Increments the per-request counter for `METHOD<US>ROUTE<US>STATUS`.
 * Called by the request-counter middleware after the handler has
 * resolved, so the recorded status is final.
 */
export function incrementRequest(method: string, route: string, status: number): void {
  const key = `${method}${METRIC_KEY_SEPARATOR}${route}${METRIC_KEY_SEPARATOR}${status}`;
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
