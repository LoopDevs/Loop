/**
 * Admin payouts-by-asset OpenAPI registration (ADR 015 / 016).
 *
 * Lifted out of `./admin-payouts-cluster.ts`. The per-asset × per-state
 * breakdown is a pure aggregation surface — the only one in the
 * payouts cluster that owns the `PerStateBreakdown` /
 * `PayoutsByAssetRow` shapes, and it doesn't share schemas or
 * threaded enums with the row-level reads (list, drill) or with the
 * settlement-lag SLA reporter. Pulling it out leaves the parent
 * focused on just the row-level surface plus the fan-outs to
 * settlement-lag + writes.
 *
 * Path in the slice:
 *   - GET /api/admin/payouts-by-asset
 *
 * Three locally-scoped schemas travel with it:
 *   - `PerStateBreakdown`
 *   - `PayoutsByAssetRow`
 *   - `PayoutsByAssetResponse`
 *
 * Only `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the by-asset breakdown path + its locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminPayoutsClusterOpenApi`.
 */
export function registerAdminPayoutsByAssetOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — payouts-by-asset breakdown (ADR 015 / 016) ────────────────────

  const PerStateBreakdown = registry.register(
    'PerStateBreakdown',
    z.object({
      count: z.number().int().min(0),
      stroops: z.string().openapi({ description: 'Sum of amount_stroops; bigint-as-string.' }),
    }),
  );

  const PayoutsByAssetRow = registry.register(
    'PayoutsByAssetRow',
    z.object({
      assetCode: z.string(),
      pending: PerStateBreakdown,
      submitted: PerStateBreakdown,
      confirmed: PerStateBreakdown,
      failed: PerStateBreakdown,
    }),
  );

  const PayoutsByAssetResponse = registry.register(
    'PayoutsByAssetResponse',
    z.object({ rows: z.array(PayoutsByAssetRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-by-asset',
    summary: 'Per-asset × per-state payout breakdown (ADR 015 / 016).',
    description:
      "Crosses `pending_payouts` by `(asset_code, state)`. The treasury snapshot gives per-state counts and per-asset outstanding liability separately; this endpoint answers the crossed question ops asks during an incident — 'I see N failed payouts, which LOOP assets are affected?'. All amounts in stroops, bigint-as-string.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'One row per asset_code present in pending_payouts',
        content: { 'application/json': { schema: PayoutsByAssetResponse } },
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
        description: 'Internal error computing the breakdown',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
