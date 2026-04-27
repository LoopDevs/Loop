/**
 * Admin cashback CSV-export OpenAPI registrations
 * (ADR 009 / 015 / 018 Tier-3).
 *
 * Lifted out of `apps/backend/src/openapi/admin-csv-exports.ts` so
 * the two cashback time-series CSVs sit together separate from the
 * payouts / merchant / supplier / treasury / operators activity
 * exports in the parent file:
 *
 *   - GET /api/admin/cashback-realization/daily.csv  (recycled-bps trend)
 *   - GET /api/admin/cashback-activity.csv           (daily accrual series)
 *
 * Both are Tier-3 finance pulls of the cashback-side aggregates
 * (the JSON siblings live on the dashboard cluster). They share
 * the same `?days` window (default 31, cap 366), the same
 * minimal 200/429/500 response declaration, and the 10/min rate
 * limit. Read together as the "cashback flywheel finance feed"
 * pair.
 *
 * Re-invoked from `registerAdminCsvExportsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/cashback-realization/daily.csv` and
 * `/api/admin/cashback-activity.csv` on the supplied registry.
 */
export function registerAdminCsvExportsCashbackOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization/daily.csv',
    summary: 'Daily cashback-realization trend CSV (ADR 009/015/018).',
    description:
      'Tier-3 finance export of /api/admin/cashback-realization/daily. Columns: day,currency,earned_minor,spent_minor,recycled_bps. LEFT-JOIN null-currency rows are dropped pre-truncation so the row cap counts real signal. Window: ?days (default 31, cap 366). Row cap 10 000.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-activity.csv',
    summary: 'Daily cashback accrual as RFC 4180 CSV (ADR 009/015/018).',
    description:
      'Tier-3 finance export of /api/admin/cashback-activity. Columns: day,currency,cashback_count,cashback_minor. Zero-activity days emit day,,,0,0. Window: ?days (default 31, cap 366). Row cap 10 000.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      429: {
        description: 'Rate limit exceeded (10/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });
}
