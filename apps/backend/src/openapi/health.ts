/**
 * Health / config section of the OpenAPI spec — schemas + path
 * registrations for the three meta endpoints the platform exposes
 * outside of the user / admin surfaces:
 *
 * - `GET /health` — liveness + upstream reachability probe
 * - `GET /metrics` — Prometheus text-format counters / gauges
 * - `GET /api/config` — public client config (feature flags +
 *   social IDs + LOOP-asset availability)
 *
 * Seventh per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders, #1156 users, #1157
 * public, #1158 admin).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components. Currently unused by the three endpoints
 *   themselves (they only document a 200 response) but accepted
 *   for parity with the other slices and for headroom on future
 *   error-path entries (e.g. a 503 for the metrics scraper if
 *   liveness ever becomes degraded-aware).
 *
 * Generated spec is byte-identical to before this slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the three meta endpoints + their associated
 * schemas on the supplied registry. Called once from openapi.ts
 * during module init.
 */
export function registerHealthOpenApi(
  registry: OpenAPIRegistry,
  _errorResponse: ReturnType<OpenAPIRegistry['register']>,
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
      upstreamReachable: z.boolean(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Liveness + upstream reachability probe.',
    tags: ['Meta'],
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: HealthResponse } } },
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
}
