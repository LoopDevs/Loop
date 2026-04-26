/**
 * `/metrics` (Prometheus) + `/openapi.json` handlers. Both are
 * gated by `probeGateAllows()` (closed-by-default in production
 * unless the matching `*_BEARER_TOKEN` env var is set + sent).
 *
 * Pulled out of `app.ts` so the Prometheus exposition emitter +
 * the OpenAPI spec serializer live next to each other; both are
 * pure ops/observability surfaces with the same auth model and
 * the same caching characteristics (no-store for live counters,
 * 1h public cache for the static spec).
 */
import type { Context } from 'hono';
import { env } from './env.js';
import { metrics } from './metrics.js';
import { getAllCircuitStates } from './circuit-breaker.js';
import { generateOpenApiSpec } from './openapi.js';
import { probeGateAllows } from './middleware/probe-gate.js';

/** Closed-by-default response when the gate rejects a request. */
function gateRejection(c: Context, expected: string | undefined): Response {
  return expected === undefined
    ? c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404)
    : c.json({ code: 'UNAUTHORIZED', message: 'Bearer token required' }, 401);
}

/**
 * `GET /metrics` — Prometheus text exposition format. Counters
 * for rate-limit hits + per-(method, route, status) request totals
 * + a circuit-breaker state gauge per upstream endpoint.
 */
export function metricsHandler(c: Context): Response {
  if (!probeGateAllows(c, env.METRICS_BEARER_TOKEN)) {
    return gateRejection(c, env.METRICS_BEARER_TOKEN);
  }
  const lines: string[] = [];

  lines.push('# HELP loop_rate_limit_hits_total Total 429 responses issued.');
  lines.push('# TYPE loop_rate_limit_hits_total counter');
  lines.push(`loop_rate_limit_hits_total ${metrics.rateLimitHitsTotal}`);
  lines.push('');

  lines.push('# HELP loop_requests_total Total HTTP requests by method/route/status.');
  lines.push('# TYPE loop_requests_total counter');
  for (const [key, count] of metrics.requestsTotal) {
    const [method, route, status] = key.split(':');
    const labels = `method="${method}",route="${route}",status="${status}"`;
    lines.push(`loop_requests_total{${labels}} ${count}`);
  }
  lines.push('');

  // Prometheus exposition format allows exactly one HELP line per
  // metric. We used to emit two (one for the description, one for
  // the state-value mapping) which some scrapers/parsers rejected
  // outright. Merge into one and move the mapping into separate
  // comment lines so the information is still visible but not
  // mistaken for metadata.
  lines.push(
    '# HELP loop_circuit_state Circuit breaker state per upstream endpoint (0=closed, 1=half_open, 2=open).',
  );
  lines.push('# TYPE loop_circuit_state gauge');
  for (const [key, state] of Object.entries(getAllCircuitStates())) {
    const val = state === 'closed' ? 0 : state === 'half_open' ? 1 : 2;
    lines.push(`loop_circuit_state{endpoint="${key}"} ${val}`);
  }

  return c.text(lines.join('\n') + '\n', 200, {
    'Content-Type': 'text/plain; version=0.0.4',
    // /metrics reports live counters + gauges. A CDN in front
    // caching this would report stale numbers to the scraper;
    // no-store makes that impossible without requiring specific
    // scraper config.
    'Cache-Control': 'no-store',
  });
}

// Generate once at module load. The spec is a pure function of the
// zod registrations in openapi.ts — it does not depend on runtime
// state — so serializing on every request would just burn CPU.
const openApiSpec = generateOpenApiSpec();

/**
 * `GET /openapi.json` — the static OpenAPI 3.1 spec. Public 1h
 * cache because the spec only changes on deploy.
 */
export function openApiHandler(c: Context): Response {
  if (!probeGateAllows(c, env.OPENAPI_BEARER_TOKEN)) {
    return gateRejection(c, env.OPENAPI_BEARER_TOKEN);
  }
  return c.json(openApiSpec, 200, { 'Cache-Control': 'public, max-age=3600' });
}
