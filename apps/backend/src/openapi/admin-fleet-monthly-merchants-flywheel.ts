/**
 * Admin merchants flywheel-share OpenAPI registrations
 * (ADR 011 / 015 / 018).
 *
 * Lifted out of `apps/backend/src/openapi/admin-fleet-monthly.ts`
 * so the three merchant-flywheel paths sit together separate from
 * the dozen other monthly / activity / drill paths in the parent
 * file:
 *
 *   - GET /api/admin/merchant-stats.csv             (per-merchant volume CSV)
 *   - GET /api/admin/merchants/flywheel-share       (recycled-share JSON)
 *   - GET /api/admin/merchants/flywheel-share.csv   (recycled-share CSV)
 *
 * The three paths read together as the "BD prep" surface — what
 * share of each merchant's volume comes from cashback recycling
 * (ADR 015 flywheel signal). The JSON view powers the admin
 * dashboard table; the two CSV companions are tier-3 finance pulls
 * for off-platform analysis. The flywheel-share pair shares the
 * same `?since=<iso>` window (default 31 days ago, max 366 days);
 * the JSON view additionally takes `?limit=` (1..100, default 25).
 * Local schemas: `MerchantFlywheelShareRow` +
 * `MerchantsFlywheelShareResponse` (mirroring the handler's
 * exported response interface); `errorResponse` crosses the slice
 * boundary.
 *
 * Re-invoked from `registerAdminFleetMonthlyOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the three merchant-flywheel paths on the supplied
 * registry. Called once from `registerAdminFleetMonthlyOpenApi`.
 */
export function registerAdminMerchantsFlywheelOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-stats.csv',
    summary: 'CSV export of per-merchant fleet statistics (ADR 011 / 018).',
    description:
      'Finance-ready CSV of per-merchant order volume, cashback paid, margin, and activity. `Cache-Control: private, no-store` + `Content-Disposition: attachment`. Row cap 10 000 with `__TRUNCATED__` sentinel.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header row lists every merchant-stats column. bigint amounts emitted as strings.',
            }),
          },
        },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // Audit fix (comprehensive audit 2026-06-11): this spec used to
  // declare a `?days` window and a z.unknown() response; the handler
  // (src/admin/merchants-flywheel-share.ts) reads `?since` + `?limit`
  // and returns `MerchantsFlywheelShareResponse`. The spec now follows
  // the handler.
  const MerchantFlywheelShareRow = registry.register(
    'MerchantFlywheelShareRow',
    z.object({
      merchantId: z.string(),
      totalFulfilledCount: z
        .number()
        .int()
        .openapi({ description: 'Total fulfilled orders at this merchant in the window.' }),
      recycledOrderCount: z.number().int().openapi({
        description: "Of those, the subset paid with `payment_method = 'loop_asset'`.",
      }),
      recycledChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) over recycled orders. bigint-as-string.',
      }),
      totalChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) over every fulfilled order. bigint-as-string.',
      }),
    }),
  );

  const MerchantsFlywheelShareResponse = registry.register(
    'MerchantsFlywheelShareResponse',
    z.object({
      since: z.string().openapi({
        format: 'date-time',
        description: 'Effective (post-clamp) window start the rows were aggregated from.',
      }),
      rows: z.array(MerchantFlywheelShareRow).openapi({
        description:
          'Sorted by recycledOrderCount descending; merchants with zero recycled orders are omitted.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/flywheel-share',
    summary: 'Fleet flywheel share per merchant (ADR 015).',
    description:
      "Per-merchant breakdown of recycled vs non-recycled orders over a window — what share of each merchant's volume comes from LOOP-asset (cashback-recycled) payments. Window: `?since=<iso>` (default 31 days ago, clamped at 366 days). Leaderboard size: `?limit=` (1..100, default 25).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description:
            'ISO-8601 window start. Default 31 days ago; older than 366 days is clamped, a future timestamp is rejected (400).',
        }),
        limit: z.coerce.number().int().min(1).max(100).optional().openapi({
          description: 'Leaderboard size. Default 25, clamped to 1..100.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant flywheel share',
        content: { 'application/json': { schema: MerchantsFlywheelShareResponse } },
      },
      400: {
        description: 'since is not a valid ISO-8601 timestamp, or is in the future',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error running the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/flywheel-share.csv',
    summary: 'CSV export of per-merchant flywheel share (ADR 015 / 018).',
    description:
      'Downloadable CSV companion to `/api/admin/merchants/flywheel-share` — same aggregate, flattened for spreadsheets. Window: `?since=<iso>` (default 31 days ago, max 366 days — older values are rejected, not clamped). `Cache-Control: private, no-store` + `Content-Disposition: attachment`. Row cap 10 000 with `__TRUNCATED__` sentinel.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional().openapi({
          description:
            'ISO-8601 window start. Default 31 days ago; more than 366 days ago is rejected (400).',
        }),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header: merchant_id, total_fulfilled_count, recycled_order_count, recycled_charge_minor, total_charge_minor. bigint amounts emitted as strings.',
            }),
          },
        },
      },
      400: {
        description: 'since is not a valid ISO-8601 timestamp, or is more than 366 days ago',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-admin callers: requireAdmin masks the admin surface as 404 by design (see src/auth/require-admin.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error building the export',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
