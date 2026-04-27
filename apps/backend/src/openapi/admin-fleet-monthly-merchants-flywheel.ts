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
 * for off-platform analysis. They share the same `?days` window
 * (default 30, cap 180) and use no admin-local schemas — only
 * `errorResponse` crosses the slice boundary.
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
      403: {
        description: 'Not an admin',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/flywheel-share',
    summary: 'Fleet flywheel share per merchant (ADR 015).',
    description:
      "Per-merchant breakdown of recycled vs non-recycled orders over a window — what share of each merchant's volume comes from LOOP-asset (cashback-recycled) payments. Window: `?days=N` (default 30, cap 180).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant flywheel share',
        content: { 'application/json': { schema: z.unknown() } },
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
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/flywheel-share.csv',
    summary: 'CSV export of per-merchant flywheel share (ADR 015 / 018).',
    description:
      'Downloadable CSV companion to `/api/admin/merchants/flywheel-share` — same columns and windowing. `Cache-Control: private, no-store` + `Content-Disposition: attachment`. Row cap 10 000 with `__TRUNCATED__` sentinel.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description: 'Header: merchantId, merchantName, recycled_count, total_count, pct.',
            }),
          },
        },
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
