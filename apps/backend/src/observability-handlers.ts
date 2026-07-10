/**
 * `/metrics` (Prometheus) + `/openapi.json` handlers. Both are
 * gated by `probeGateAllows()` (closed-by-default in production
 * unless the matching `*_BEARER_TOKEN` env var is set + sent).
 *
 * Pulled out of `app.ts` so the Prometheus exposition emitter +
 * the OpenAPI spec serializer live next to each other; both are
 * pure ops/observability surfaces with the same auth model and
 * the same caching characteristics (no-store for live counters,
 * no-store for the bearer-gated spec).
 */
import type { Context } from 'hono';
import { env } from './env.js';
import {
  METRIC_KEY_SEPARATOR,
  REQUEST_DURATION_BUCKETS_SECONDS,
  WEB_VITAL_BUCKETS,
  WEB_VITAL_NAMES,
  metrics,
} from './metrics.js';
import { getAllCircuitStates } from './circuit-breaker.js';
import { generateOpenApiSpec } from './openapi.js';
import { probeGateAllows } from './middleware/probe-gate.js';
import { getRuntimeHealthSnapshot } from './runtime-health.js';
import { getMerchants } from './merchants/sync.js';
import { getLocations } from './clustering/data-store.js';
import { merchantCatalogStaleAfterMs, locationCatalogStaleAfterMs } from './health.js';
import { getGeoDbStatus } from './public/geo.js';
import { currentFleetSizeEstimate, currentFleetSizeSource } from './middleware/fleet-size.js';

/** Closed-by-default response when the gate rejects a request. */
function gateRejection(c: Context, expected: string | undefined): Response {
  return expected === undefined
    ? c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404, probeScopedHeaders())
    : c.json({ code: 'UNAUTHORIZED', message: 'Bearer token required' }, 401, probeScopedHeaders());
}

function probeScopedHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization',
  };
}

/**
 * `GET /metrics` — Prometheus text exposition format. Counters
 * for rate-limit hits + per-(method, route, status) request totals
 * + a circuit-breaker state gauge per upstream endpoint.
 */
export async function metricsHandler(c: Context): Promise<Response> {
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
    // A4-076: split on the Unit Separator (\x1f) used by
    // `incrementRequest` so route patterns containing `:` (Hono's
    // parameter syntax, e.g. `/api/orders/:id`) round-trip
    // correctly. Earlier code split on `:` and truncated the route
    // at the parameter, mislabelling the status as the parameter
    // name. Escape Prometheus label values defensively so a route
    // name with a `"` or `\` wouldn't break the line — none does
    // today, but the cost is one regex per emit.
    const [method, route, status] = key.split(METRIC_KEY_SEPARATOR);
    const labels =
      `method="${escapePromLabel(method ?? '')}",` +
      `route="${escapePromLabel(route ?? '')}",` +
      `status="${escapePromLabel(status ?? '')}"`;
    lines.push(`loop_requests_total{${labels}} ${count}`);
  }
  lines.push('');

  // A4-048: per-(method, route) latency histogram. Operators paired
  // with `loop_requests_total{status=~"5.."}` to compute the SLI
  // pair the SLO doc commits to (p95 latency, 5xx rate). Bucket
  // labels are `le=<seconds>` per Prometheus convention; the +Inf
  // bucket is required and is sourced from the histogram's `count`.
  lines.push(
    '# HELP loop_request_duration_seconds Request handler duration by method/route, in seconds.',
  );
  lines.push('# TYPE loop_request_duration_seconds histogram');
  for (const [key, hist] of metrics.requestDurationHistograms) {
    const [method, route] = key.split(METRIC_KEY_SEPARATOR);
    const baseLabels = `method="${escapePromLabel(method ?? '')}",route="${escapePromLabel(route ?? '')}"`;
    for (let i = 0; i < REQUEST_DURATION_BUCKETS_SECONDS.length; i++) {
      const upper = REQUEST_DURATION_BUCKETS_SECONDS[i]!;
      lines.push(
        `loop_request_duration_seconds_bucket{${baseLabels},le="${upper}"} ${hist.buckets[i]}`,
      );
    }
    lines.push(`loop_request_duration_seconds_bucket{${baseLabels},le="+Inf"} ${hist.count}`);
    lines.push(`loop_request_duration_seconds_sum{${baseLabels}} ${hist.sumSeconds}`);
    lines.push(`loop_request_duration_seconds_count{${baseLabels}} ${hist.count}`);
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
  lines.push('');

  const runtime = getRuntimeHealthSnapshot();
  lines.push(
    '# HELP loop_runtime_surface_degraded Runtime surface degradation state (1=degraded, 0=healthy).',
  );
  lines.push('# TYPE loop_runtime_surface_degraded gauge');
  lines.push(
    `loop_runtime_surface_degraded{surface="otp_delivery"} ${runtime.otpDelivery.degraded ? 1 : 0}`,
  );
  lines.push('');

  lines.push('# HELP loop_worker_running Worker process state (1=running, 0=not running).');
  lines.push('# TYPE loop_worker_running gauge');
  for (const worker of runtime.workers) {
    lines.push(`loop_worker_running{worker="${worker.name}"} ${worker.running ? 1 : 0}`);
  }
  lines.push('');

  lines.push('# HELP loop_worker_degraded Worker health state (1=degraded, 0=healthy).');
  lines.push('# TYPE loop_worker_degraded gauge');
  for (const worker of runtime.workers) {
    lines.push(`loop_worker_degraded{worker="${worker.name}"} ${worker.degraded ? 1 : 0}`);
  }
  lines.push('');

  lines.push(
    "# HELP loop_worker_last_success_timestamp_ms Unix timestamp in ms of the worker's last successful tick.",
  );
  lines.push('# TYPE loop_worker_last_success_timestamp_ms gauge');
  for (const worker of runtime.workers) {
    if (worker.lastSuccessAtMs !== null) {
      lines.push(
        `loop_worker_last_success_timestamp_ms{worker="${worker.name}"} ${worker.lastSuccessAtMs}`,
      );
    }
  }
  lines.push('');

  // B-5: S4-8's "alive but not leading" distinction wasn't previously
  // scrapeable — only /health's JSON carried lastLeadTickAtMs/stale. A
  // fleet where every machine is alive (lastSuccessAtMs fresh) but NONE
  // of them has led a tick in a while is wedged even though the existing
  // loop_worker_running/loop_worker_degraded gauges read healthy.
  lines.push(
    "# HELP loop_worker_last_lead_tick_timestamp_ms Unix timestamp in ms this machine last won a single-flighted worker's fleet-wide lock (or last ticked, for workers with no lock).",
  );
  lines.push('# TYPE loop_worker_last_lead_tick_timestamp_ms gauge');
  for (const worker of runtime.workers) {
    if (worker.lastLeadTickAtMs !== null) {
      lines.push(
        `loop_worker_last_lead_tick_timestamp_ms{worker="${worker.name}"} ${worker.lastLeadTickAtMs}`,
      );
    }
  }
  lines.push('');

  lines.push('# HELP loop_worker_stale Worker staleness state (1=stale, 0=fresh).');
  lines.push('# TYPE loop_worker_stale gauge');
  for (const worker of runtime.workers) {
    lines.push(`loop_worker_stale{worker="${worker.name}"} ${worker.stale ? 1 : 0}`);
  }
  lines.push('');

  // B-5: docs/slo.md §Freshness pins "merchant catalog age ≤ 2x
  // REFRESH_INTERVAL_HOURS" / "location clusters age ≤ 2x
  // LOCATION_REFRESH_INTERVAL_HOURS" as SLOs, but until now that data
  // only reached operators via /health's JSON body (not scrapeable /
  // dashboard-able / alertable via Prometheus). Both reads are in-memory
  // cache lookups (merchants/sync.js, clustering/data-store.js) — no DB
  // or upstream call, so this stays as cheap as the rest of /metrics.
  const { loadedAt: merchantsLoadedAtMs } = getMerchants();
  const { loadedAt: locationsLoadedAtMs } = getLocations();
  const merchantsStale = Date.now() - merchantsLoadedAtMs > merchantCatalogStaleAfterMs();
  const locationsStale = Date.now() - locationsLoadedAtMs > locationCatalogStaleAfterMs();

  lines.push(
    "# HELP loop_catalog_loaded_timestamp_ms Unix timestamp in ms of the catalog's last successful load.",
  );
  lines.push('# TYPE loop_catalog_loaded_timestamp_ms gauge');
  lines.push(`loop_catalog_loaded_timestamp_ms{catalog="merchants"} ${merchantsLoadedAtMs}`);
  lines.push(`loop_catalog_loaded_timestamp_ms{catalog="locations"} ${locationsLoadedAtMs}`);
  lines.push('');

  lines.push(
    '# HELP loop_catalog_stale Catalog freshness state vs its docs/slo.md Freshness target (1=stale, 0=fresh).',
  );
  lines.push('# TYPE loop_catalog_stale gauge');
  lines.push(`loop_catalog_stale{catalog="merchants"} ${merchantsStale ? 1 : 0}`);
  lines.push(`loop_catalog_stale{catalog="locations"} ${locationsStale ? 1 : 0}`);
  lines.push('');

  // B-5: mirrors /health's geoDbStale soft-degraded reason. `stale` is
  // already false-for-both-fresh-and-unconfigured (see GeoDbStatus's doc
  // comment in public/geo.ts) so this gauge can't false-alarm on a
  // deployment that never configured MAXMIND_GEOLITE2_PATH. The reader
  // is memoized after first open (no repeated file I/O per scrape).
  const geoDbStatus = await getGeoDbStatus();
  lines.push('# HELP loop_geo_db_stale GeoLite2 database staleness state (1=stale, 0=fresh).');
  lines.push('# TYPE loop_geo_db_stale gauge');
  lines.push(`loop_geo_db_stale ${geoDbStatus.stale ? 1 : 0}`);
  lines.push('');
  if (geoDbStatus.ageDays !== null) {
    lines.push('# HELP loop_geo_db_build_age_days Age in whole days of the loaded GeoLite2 build.');
    lines.push('# TYPE loop_geo_db_build_age_days gauge');
    lines.push(`loop_geo_db_build_age_days ${geoDbStatus.ageDays}`);
    lines.push('');
  }

  // B-5: S4-4's per-machine → fleet-wide rate-limit budget divisor,
  // previously only visible via /health JSON. `source` is a label
  // rather than folded into the gauge value so both facts stay queryable
  // independently (mirrors the loop_circuit_state 0/1/2 gauge pattern).
  lines.push(
    '# HELP loop_rate_limit_fleet_estimate Current divisor the rate limiter uses for its per-machine to fleet-wide budget conversion.',
  );
  lines.push('# TYPE loop_rate_limit_fleet_estimate gauge');
  lines.push(`loop_rate_limit_fleet_estimate ${currentFleetSizeEstimate()}`);
  lines.push('');

  lines.push(
    '# HELP loop_rate_limit_fleet_estimate_source Source of the fleet-size estimate (0=static fallback, 1=dynamic DNS-derived).',
  );
  lines.push('# TYPE loop_rate_limit_fleet_estimate_source gauge');
  lines.push(
    `loop_rate_limit_fleet_estimate_source ${currentFleetSizeSource() === 'dynamic' ? 1 : 0}`,
  );
  lines.push('');

  // ADR 048: Core Web Vitals captured via POST /api/public/rum. Unit
  // varies by vital — ms for LCP/INP/FCP/TTFB, an unitless layout-
  // shift score for CLS — called out in the HELP line since
  // Prometheus has no native per-label-value unit concept.
  lines.push(
    '# HELP loop_web_vital Core Web Vital observations from real users (ms for LCP/INP/FCP/TTFB, unitless score for CLS).',
  );
  lines.push('# TYPE loop_web_vital histogram');
  for (const name of WEB_VITAL_NAMES) {
    const hist = metrics.webVitals[name];
    const bounds = WEB_VITAL_BUCKETS[name];
    for (let i = 0; i < bounds.length; i++) {
      lines.push(`loop_web_vital_bucket{vital="${name}",le="${bounds[i]}"} ${hist.buckets[i]}`);
    }
    lines.push(`loop_web_vital_bucket{vital="${name}",le="+Inf"} ${hist.count}`);
    lines.push(`loop_web_vital_sum{vital="${name}"} ${hist.sum}`);
    lines.push(`loop_web_vital_count{vital="${name}"} ${hist.count}`);
  }
  lines.push('');

  lines.push(
    '# HELP loop_page_views_total Total page-view events recorded via POST /api/public/rum (ADR 048).',
  );
  lines.push('# TYPE loop_page_views_total counter');
  lines.push(`loop_page_views_total ${metrics.pageViewsTotal}`);

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
 * `GET /openapi.json` — the static OpenAPI 3.1 spec. Even though the
 * payload only changes on deploy, we still send `private, no-store`
 * plus `Vary: Authorization` because the bearer gate changes whether
 * an admin-inclusive spec is reachable at all.
 */
export function openApiHandler(c: Context): Response {
  if (!probeGateAllows(c, env.OPENAPI_BEARER_TOKEN)) {
    return gateRejection(c, env.OPENAPI_BEARER_TOKEN);
  }
  return c.json(openApiSpec, 200, probeScopedHeaders());
}

/**
 * A4-076: escape a Prometheus exposition label value per
 * https://prometheus.io/docs/instrumenting/exposition_formats/.
 * Only `\\`, `"`, and `\n` need escaping inside a quoted label.
 * Defensive: route patterns from Hono never contain these today,
 * but a future router or a regression that put raw URL chunks into
 * the label would otherwise break the line format.
 */
function escapePromLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
