/**
 * Load-test scenario: anonymous browse traffic — clusters map, full
 * catalog, per-merchant slug lookups. No auth involved.
 *
 * Hits the same three GETs the web home/map/gift-card-detail surfaces
 * make (apps/backend/src/routes/misc.ts + routes/merchants.ts):
 *   - GET /api/clusters            — apps/backend/src/clustering/handler.ts
 *   - GET /api/merchants/all       — apps/backend/src/merchants/handler.ts
 *   - GET /api/merchants/by-slug/:slug
 *
 * Run via tools/load-test/run-local.sh, or directly:
 *   k6 run -e BASE_URL=http://localhost:8081 tools/load-test/browse.js
 *
 * See docs/load-testing.md for the full harness writeup + measured
 * baselines.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, COMMON_THRESHOLDS, scaleStages } from './config.js';

const errorRate = new Rate('errors');

// A realistic-shaped bbox (continental US at a "regional" zoom) — the
// query-param names/types (west/south/east/north floats + integer zoom)
// come straight from clustersHandler's validation in
// apps/backend/src/clustering/handler.ts. mock-ctx's /locations fixture is
// seeded empty (tests/e2e-mocked/fixtures/mock-ctx.mjs), so against the
// local mocked stack this always resolves to an empty cluster set — it
// still exercises the full parse → validate → bbox-expand → filter →
// cluster → encode path, and is the right shape to point at a populated
// catalog (staging/prod) later.
const BBOX = { west: -125, south: 25, east: -66, north: 49, zoom: 10 };

// Merchant slugs from the mock-ctx seed catalog (mock-amazon / mock-target
// / mock-starbucks → merchantSlug() lowercases the name — see
// packages/shared/src/slugs.ts). Kept in sync by hand since the mock
// catalog is a small fixed fixture, not something this script can discover
// cheaply without an extra request per iteration.
const SLUGS = ['amazon', 'target', 'starbucks'];

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      // Scaled by VUS_SCALE (default 1) — see config.js::scaleStages.
      stages: scaleStages([
        { duration: '30s', target: 5 },
        { duration: '1m', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '30s', target: 0 },
      ]),
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    ...COMMON_THRESHOLDS,
    // docs/slo.md: "/api/merchants (cached) p95 duration ≤ 200ms". /all and
    // /by-slug are both cached-catalog reads (5-minute Cache-Control) in
    // the same latency class as the SLO's named route.
    'http_req_duration{name:merchants_all}': ['p(95)<200'],
    'http_req_duration{name:merchants_by_slug}': ['p(95)<200'],
  },
};

export default function () {
  let res = http.get(
    `${BASE_URL}/api/clusters?west=${BBOX.west}&south=${BBOX.south}&east=${BBOX.east}&north=${BBOX.north}&zoom=${BBOX.zoom}`,
    { tags: { name: 'clusters' } },
  );
  if (!check(res, { 'clusters: 200': (r) => r.status === 200 })) errorRate.add(1);

  res = http.get(`${BASE_URL}/api/merchants/all?fields=lite`, {
    tags: { name: 'merchants_all' },
  });
  if (
    !check(res, {
      'merchants/all: 200': (r) => r.status === 200,
      'merchants/all: has merchants[]': (r) => Array.isArray(r.json('merchants')),
    })
  ) {
    errorRate.add(1);
  }

  const slug = SLUGS[Math.floor(Math.random() * SLUGS.length)];
  res = http.get(`${BASE_URL}/api/merchants/by-slug/${slug}`, {
    tags: { name: 'merchants_by_slug' },
  });
  if (!check(res, { 'by-slug: 200': (r) => r.status === 200 })) errorRate.add(1);

  sleep(1);
}
