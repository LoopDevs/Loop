/**
 * Health / config section of the OpenAPI spec — schemas + path
 * registrations for the meta endpoints the platform exposes
 * outside of the user / admin surfaces:
 *
 * - `GET /health` — liveness + upstream reachability probe
 * - `GET /metrics` — Prometheus text-format counters / gauges
 * - `GET /openapi.json` — this spec itself (probe-gated)
 * - `GET /api/config` — public client config (feature flags +
 *   social IDs + LOOP-asset availability)
 *
 * Seventh per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders, #1156 users, #1157
 * public, #1158 admin).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components. Used by the 429 on /api/config, the 503 on
 *   /health (critical degradation — A4-035 / A4-073), and the
 *   probe-gate rejection codes (401/404) on /openapi.json.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the meta endpoints + their associated schemas on the
 * supplied registry. Called once from openapi.ts during module
 * init.
 */
export function registerHealthOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Public config (ADR 013 / 014 / 015) ────────────────────────────────────

  const LoopAssetConfig = z.object({
    issuer: z.string().nullable().openapi({
      description: 'Stellar issuer account for this LOOP asset, null when unconfigured.',
    }),
    available: z.boolean().openapi({
      description: 'Convenience flag — `issuer !== null`. `true` means on-chain payout is live.',
    }),
  });

  const AppConfigResponse = registry.register(
    'AppConfigResponse',
    z.object({
      loopAuthNativeEnabled: z.boolean().openapi({
        description: 'ADR 013 — Loop-native auth (OTP + Loop-minted JWTs) is active.',
      }),
      loopOrdersEnabled: z.boolean().openapi({
        description:
          'ADR 010 — Loop-native orders can be placed (auth + workers + deposit address all configured).',
      }),
      phase1Only: z.boolean().openapi({
        description:
          'Tranche 1 (MVP) gate. When true, the web client hides every Phase 2+ surface. Toggled server-side via LOOP_PHASE_1_ONLY.',
      }),
      loopAssets: z.object({
        USDLOOP: LoopAssetConfig,
        GBPLOOP: LoopAssetConfig,
        EURLOOP: LoopAssetConfig,
      }),
      social: z.object({
        googleClientIdWeb: z.string().nullable(),
        googleClientIdIos: z.string().nullable(),
        googleClientIdAndroid: z.string().nullable(),
        appleServiceId: z.string().nullable(),
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/config',
    summary: 'Public client config — feature flags + social IDs + LOOP-asset availability.',
    description:
      'Unauthenticated. Returned fields are safe to ship in the web / mobile bundle. Clients cache for up to 10 minutes per the Cache-Control response header.',
    tags: ['Config'],
    responses: {
      200: {
        description: 'App config',
        content: { 'application/json': { schema: AppConfigResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Health / metrics ───────────────────────────────────────────────────────

  const HealthResponse = registry.register(
    'HealthResponse',
    z.object({
      status: z.enum(['healthy', 'degraded']),
      locationCount: z.number(),
      locationsLoading: z.boolean(),
      merchantCount: z.number(),
      merchantsLoadedAt: z.string().openapi({ format: 'date-time' }),
      locationsLoadedAt: z.string().openapi({ format: 'date-time' }),
      merchantsStale: z.boolean(),
      locationsStale: z.boolean(),
      geoDbStale: z.boolean().openapi({
        description:
          'GeoLite2-Country .mmdb staleness/absence signal (go-live-plan §T1-F). False both when fresh AND when MAXMIND_GEOLITE2_PATH was never configured (deliberate — see docs/deployment.md §GeoLite2); true when stale (>45 days old) or configured-but-unopenable.',
      }),
      geoDbBuildEpoch: z.string().nullable().openapi({
        format: 'date-time',
        description: 'GeoLite2 .mmdb build timestamp, null when unavailable.',
      }),
      rateLimitFleetEstimate: z.number().int().openapi({
        description:
          'S4-4 — current fleet-size divisor the rate limiter applies to every configured per-route budget (docs/readiness-backlog-2026-07-03.md §S4-4). Sourced from a live Fly `.internal` DNS count when fresh, else the static RATE_LIMIT_MACHINE_COUNT_ESTIMATE fallback.',
      }),
      rateLimitFleetEstimateSource: z.enum(['dynamic', 'static']).openapi({
        description:
          "'dynamic' when a fresh `.internal` DNS read is in effect; 'static' when running on the RATE_LIMIT_MACHINE_COUNT_ESTIMATE fallback (FLY_APP_NAME unset, or DNS unavailable past the grace period).",
      }),
      upstreamReachable: z.boolean(),
      otpDelivery: z.object({
        enabled: z.boolean(),
        degraded: z.boolean(),
        lastSuccessAtMs: z.number().int().nullable(),
        lastFailureAtMs: z.number().int().nullable(),
        lastError: z.string().nullable(),
      }),
      workers: z.array(
        z.object({
          name: z.enum([
            'asset_drift_watcher',
            'interest_mint',
            'interest_scheduler',
            'payment_watcher',
            'payout_worker',
            'procurement_worker',
            'redemption_backfill',
            'wallet_provisioning',
          ]),
          required: z.boolean(),
          running: z.boolean(),
          degraded: z.boolean(),
          stale: z.boolean(),
          blockedReason: z.string().nullable(),
          startedAtMs: z.number().int().nullable(),
          lastSuccessAtMs: z.number().int().nullable(),
          lastErrorAtMs: z.number().int().nullable(),
          lastError: z.string().nullable(),
          staleAfterMs: z.number().int().nullable(),
          // S4-8: single-flighted workers distinguish "alive but lost
          // the fleet-wide lock" (lastSkippedLockedAtMs) from "actually
          // did the work" (lastLeadTickAtMs). lastSuccessAtMs stays the
          // liveness stamp (advanced by both), so degraded semantics
          // are unchanged; these two let an operator see a machine
          // that is alive but hasn't led in N minutes.
          lastSkippedLockedAtMs: z.number().int().nullable(),
          lastLeadTickAtMs: z.number().int().nullable(),
        }),
      ),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Liveness + upstream reachability probe.',
    tags: ['Meta'],
    responses: {
      200: {
        description: 'OK (including soft degradation — stale caches, upstream unreachable)',
        content: { 'application/json': { schema: HealthResponse } },
      },
      503: {
        description:
          'Critical degradation — DB unreachable or a required worker is down (A4-035 / A4-073). Body is the same HealthResponse shape with status: degraded; orchestrators (Fly) cycle the machine on this.',
        content: { 'application/json': { schema: HealthResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/metrics',
    summary: 'Prometheus-format metrics (counters, gauges).',
    tags: ['Meta'],
    responses: {
      200: {
        description: 'Prometheus text format',
        content: { 'text/plain; version=0.0.4': { schema: z.string() } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/openapi.json',
    summary: 'This OpenAPI 3.1 document.',
    description:
      'Probe-gated (closed-by-default in production): without OPENAPI_BEARER_TOKEN configured the endpoint masks itself as 404; with it configured, requests must present the bearer or receive 401. Responses carry `Cache-Control: private, no-store` + `Vary: Authorization`.',
    tags: ['Meta'],
    responses: {
      200: {
        description: 'The OpenAPI 3.1 spec document',
        content: {
          'application/json': {
            schema: z
              .record(z.string(), z.unknown())
              .openapi({ description: 'OpenAPI 3.1 document.' }),
          },
        },
      },
      401: {
        description: 'OPENAPI_BEARER_TOKEN is configured and the request bearer is missing/wrong',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Probe gate closed (production without OPENAPI_BEARER_TOKEN configured)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
