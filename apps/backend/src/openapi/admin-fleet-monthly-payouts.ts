/**
 * Admin payouts-aggregate OpenAPI registrations
 * (ADR 015 / 016).
 *
 * Lifted out of `apps/backend/src/openapi/admin-fleet-monthly.ts`
 * so the two confirmed-payout fleet aggregates sit alongside their
 * five locally-scoped schemas, separate from the orders / cashback /
 * merchant / drill paths in the parent file:
 *
 *   - GET /api/admin/payouts-monthly   (fixed 12-month window, per-asset)
 *   - GET /api/admin/payouts-activity  (daily sparkline, per-asset)
 *
 * The two paths are the settlement-side counterparts of the
 * cashback aggregates — they answer "is the on-chain LOOP-asset
 * outflow keeping pace with the cashback accrual?". Read together
 * with /api/admin/cashback-monthly (parent file) and
 * /api/admin/cashback-activity (dashboard cluster).
 *
 * Locally-scoped schemas (none referenced elsewhere — they travel
 * with the slice):
 *   - `AdminPayoutsMonthlyEntry` / `AdminPayoutsMonthlyResponse`
 *   - `PerAssetPayoutAmount`
 *   - `PayoutsActivityDay` / `PayoutsActivityResponse`
 *
 * Re-invoked from `registerAdminFleetMonthlyOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/payouts-monthly` and
 * `/api/admin/payouts-activity` plus their five locally-scoped
 * schemas on the supplied registry.
 */
export function registerAdminPayoutsAggregatesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminPayoutsMonthlyEntry = registry.register(
    'AdminPayoutsMonthlyEntry',
    z.object({
      month: z.string().openapi({ description: '"YYYY-MM" in UTC.' }),
      assetCode: z.string().openapi({
        description: 'LOOP asset code — USDLOOP / GBPLOOP / EURLOOP or future additions.',
      }),
      paidStroops: z.string().openapi({ description: 'bigint-as-string stroops.' }),
      payoutCount: z.number().int(),
    }),
  );

  const AdminPayoutsMonthlyResponse = registry.register(
    'AdminPayoutsMonthlyResponse',
    z.object({ entries: z.array(AdminPayoutsMonthlyEntry) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-monthly',
    summary: 'Settlement counterpart to /cashback-monthly (ADR 015/016).',
    description:
      'Fixed 12-month window; filter state=confirmed; bucket on (month, assetCode). Pair with /cashback-monthly to answer "is outstanding LOOP-asset liability growing or shrinking this month?". bigint-as-string on paidStroops.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-(month, assetCode) confirmed-payout totals',
        content: { 'application/json': { schema: AdminPayoutsMonthlyResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const PerAssetPayoutAmount = registry.register(
    'PerAssetPayoutAmount',
    z.object({
      assetCode: z.string(),
      stroops: z.string().openapi({ description: 'bigint-as-string.' }),
      count: z.number().int(),
    }),
  );

  const PayoutsActivityDay = registry.register(
    'PayoutsActivityDay',
    z.object({
      day: z.string().openapi({ description: 'YYYY-MM-DD (UTC).' }),
      count: z.number().int(),
      byAsset: z.array(PerAssetPayoutAmount),
    }),
  );

  const PayoutsActivityResponse = registry.register(
    'PayoutsActivityResponse',
    z.object({
      days: z.number().int(),
      rows: z.array(PayoutsActivityDay),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts-activity',
    summary:
      'Daily confirmed-payout sparkline — settlement sibling of cashback-activity (ADR 015/016).',
    description:
      'generate_series LEFT JOIN zero-fills every day. Bucketed on confirmed_at::date. ?days default 30, max 180. Per (day, assetCode) so UI can render per-asset sparklines. bigint-as-string on stroops.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily confirmed-payout series',
        content: { 'application/json': { schema: PayoutsActivityResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });
}
