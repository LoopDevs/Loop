/**
 * Per-request counter middleware. Runs AFTER the handler resolves
 * so it observes the final response status. Increments
 * `metrics.requestsTotal` keyed by `METHOD:ROUTE:STATUS` — that
 * counter is what `/metrics` exposes as `loop_requests_total`.
 *
 * Mount order: this middleware should run after every other
 * middleware + the matched handler (Hono runs middleware in
 * registration order, then the handler, then the trailing half
 * of each middleware in reverse — `await next()` then increment
 * gives us the post-handler observation).
 *
 * **Audit A-022 cardinality cap**: unmatched paths used to emit
 * the raw URL as the route label. A fuzz scan (or an ordinary
 * crawler) could spray `/api/foo`, `/api/bar`, `/xyz-…` and each
 * would create a fresh metric key, ballooning the Prometheus
 * series cardinality until the map (and the scraper) struggled.
 * We collapse every unmatched route to the constant label
 * `NOT_FOUND` so cardinality stays O(declared routes) rather
 * than O(observed URLs). Hono sets `routePath` to the matched
 * middleware pattern when no route handler matches (for us,
 * that's the wildcard catch-all `'/*'` or `'*'`); both are
 * treated as `NOT_FOUND`, everything else is a real registered
 * route.
 *
 * The `/metrics` endpoint itself is skipped so we don't count
 * our own scraper.
 */
import type { Context } from 'hono';
import { incrementRequest, recordRequestDuration } from '../metrics.js';

export async function requestCounterMiddleware(
  c: Context,
  next: () => Promise<void>,
): Promise<void> {
  // A4-048: capture wall-clock for the latency histogram. `performance.now()`
  // is monotonic (no Date.now skew) and resolves in fractional ms.
  // Compute duration AFTER `next()` resolves so the recorded value
  // reflects the full middleware-and-handler chain, matching the
  // request-counter's post-handler observation point.
  const startMs = performance.now();
  await next();
  if (c.req.path === '/metrics') return;
  const raw = c.req.routePath;
  const route = raw === undefined || raw === '/*' || raw === '*' ? 'NOT_FOUND' : raw;
  incrementRequest(c.req.method, route, c.res.status);
  recordRequestDuration(c.req.method, route, (performance.now() - startMs) / 1000);
}
