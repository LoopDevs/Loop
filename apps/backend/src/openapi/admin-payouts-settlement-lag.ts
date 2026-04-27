/**
 * Admin payouts settlement-lag SLA OpenAPI registration
 * (ADR 015 / 016).
 *
 * Lifted out of `./admin-payouts-cluster.ts`. The settlement-lag
 * surface is the only one in the payouts cluster that's a pure
 * SLA reporter — percentile latency from `pending_payouts.createdAt`
 * to `confirmedAt` for the `confirmed` slice. It owns its own
 * `SettlementLagRow` + `SettlementLagResponse` schemas, doesn't
 * share enums with the other paths, and exists alongside (rather
 * than extending) the list/drill/by-asset reads. Pulling it out
 * leaves the parent file focused on the row-level surface (list +
 * drill + by-asset breakdown) and the two ADR-017 writes (retry +
 * compensate) it fans out to.
 *
 * Path in the slice:
 *   - GET /api/admin/payouts/settlement-lag
 *
 * Two locally-scoped schemas travel with it:
 *   - `SettlementLagRow`
 *   - `SettlementLagResponse`
 *
 * Only `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the settlement-lag path + its locally-scoped schemas
 * on the supplied registry. Called once from
 * `registerAdminPayoutsClusterOpenApi`.
 */
export function registerAdminPayoutsSettlementLagOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — settlement-lag SLA (ADR 015 / 016) ────────────────────────────

  const SettlementLagRow = registry.register(
    'SettlementLagRow',
    z.object({
      assetCode: z.string().nullable().openapi({
        description: 'LOOP asset code; `null` for the fleet-wide aggregate row.',
      }),
      sampleCount: z.number().int().nonnegative(),
      p50Seconds: z.number().nonnegative(),
      p95Seconds: z.number().nonnegative(),
      maxSeconds: z.number().nonnegative(),
      meanSeconds: z.number().nonnegative(),
    }),
  );

  const SettlementLagResponse = registry.register(
    'SettlementLagResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(SettlementLagRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts/settlement-lag',
    summary: 'Payout settlement-lag SLA (ADR 015 / 016).',
    description:
      "Percentile latency (in seconds) from `pending_payouts` insert (`createdAt`) to on-chain confirmation (`confirmedAt`) for `state='confirmed'` rows in the window. One row per LOOP asset, plus a fleet-wide aggregate where `assetCode: null`. The user-facing SLA: if p95 is minutes we're healthy; hours means the payout worker or Horizon is backed up and users are waiting. Window: `?since=<iso>` (default 24h, cap 366d). Same clamp as the operator-latency endpoint.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description: 'ISO-8601 — lower bound on `confirmedAt`. Defaults to 24h ago.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Per-asset rows plus fleet-wide aggregate',
        content: { 'application/json': { schema: SettlementLagResponse } },
      },
      400: {
        description: 'Malformed `since` or window > 366d',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      403: {
        description: 'Not an admin',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
