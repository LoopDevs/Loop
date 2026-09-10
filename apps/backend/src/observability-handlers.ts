// /metrics + /openapi.json — probe-gated, no-store — A4-076, A4-048, B-5, FT-07, NS-02, ADR 048
import type { Context } from 'hono';
import { config } from './config/index.js';
import {
  METRIC_KEY_SEPARATOR,
  REQUEST_DURATION_BUCKETS_SECONDS,
  WEB_VITAL_BUCKETS,
  WEB_VITAL_NAMES,
  getMoneyIntegritySignals,
  metrics,
} from './metrics.js';
import { probeGateAllows } from './middleware/probe-gate.js';
import { getRuntimeHealthSnapshot } from './runtime-health.js';
import { getMerchants } from './merchants/sync.js';
import { getLocations } from './clustering/data-store.js';
import { merchantCatalogStaleAfterMs, locationCatalogStaleAfterMs } from './health.js';
import { getGeoDbStatus } from './public/geo.js';
import { currentFleetSizeEstimate, currentFleetSizeSource } from './middleware/fleet-size.js';

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

export async function metricsHandler(c: Context): Promise<Response> {
  if (!probeGateAllows(c, config.observability.metrics.bearerToken)) {
    return gateRejection(c, config.observability.metrics.bearerToken);
  }
  const lines: string[] = [];

  lines.push('# HELP loop_rate_limit_hits_total Total 429 responses issued.');
  lines.push('# TYPE loop_rate_limit_hits_total counter');
  lines.push(`loop_rate_limit_hits_total ${metrics.rateLimitHitsTotal}`);
  lines.push('');

  lines.push('# HELP loop_requests_total Total HTTP requests by method/route/status.');
  lines.push('# TYPE loop_requests_total counter');
  for (const [key, count] of metrics.requestsTotal) {
    // A4-076: split on \x1f so Hono route params (e.g. `/api/orders/:id`) round-trip;
    // escape labels defensively to prevent line-format breakage.
    const [method, route, status] = key.split(METRIC_KEY_SEPARATOR);
    const labels =
      `method="${escapePromLabel(method ?? '')}",` +
      `route="${escapePromLabel(route ?? '')}",` +
      `status="${escapePromLabel(status ?? '')}"`;
    lines.push(`loop_requests_total{${labels}} ${count}`);
  }
  lines.push('');

  // A4-048: latency histogram for SLO SLI pair (p95 latency, 5xx rate).
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

  // B-5: exposes "alive but not leading" state to detect wedged fleets where
  // all machines are fresh but none has won the single-flight lock recently.
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

  // FT-07 / NS-02: money-integrity breach gauges; scrapeable/alertable independent of Discord.
  lines.push(
    '# HELP loop_money_integrity_breach_active Money-integrity invariant breach state per watcher signal (1=standing breach, 0=clean). Independent of Discord delivery (FT-07/NS-02).',
  );
  lines.push('# TYPE loop_money_integrity_breach_active gauge');
  for (const [signal, state] of getMoneyIntegritySignals()) {
    lines.push(`loop_money_integrity_breach_active{signal="${signal}"} ${state.active ? 1 : 0}`);
  }
  lines.push('');

  lines.push(
    '# HELP loop_money_integrity_last_evaluated_timestamp_ms Unix timestamp in ms of the last tick that actually evaluated this money-integrity signal (absent = never evaluated / not currently being checked).',
  );
  lines.push('# TYPE loop_money_integrity_last_evaluated_timestamp_ms gauge');
  for (const [signal, state] of getMoneyIntegritySignals()) {
    if (state.lastEvaluatedAtMs !== null) {
      lines.push(
        `loop_money_integrity_last_evaluated_timestamp_ms{signal="${signal}"} ${state.lastEvaluatedAtMs}`,
      );
    }
  }
  lines.push('');

  // B-5: exposes catalog freshness SLOs (docs/slo.md) to Prometheus; in-memory lookups only.
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

  // B-5: mirrors /health geoDbStale; `stale` is false for unconfigured deployments to prevent false alarms.
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

  // B-5: exposes fleet-size divisor for rate-limit budget conversion to Prometheus.
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

  // ADR 048: Core Web Vitals; unit varies by vital (ms vs unitless score).
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
    // no-store prevents CDN from serving stale live counters to scrapers.
    'Cache-Control': 'no-store',
  });
}

// A4-076: escape Prometheus label values per spec; defensive against future router changes.
function escapePromLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
