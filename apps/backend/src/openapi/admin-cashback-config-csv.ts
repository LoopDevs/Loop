/**
 * Admin cashback-config CSV export OpenAPI registration
 * (ADR 011 / 018).
 *
 * Lifted out of `./admin-cashback-config.ts`. Tier-3 bulk export
 * per ADR 018 — finance / audit consumes the snapshot in a
 * spreadsheet. Co-located with its sibling CSV exports' fan-out
 * pattern (`admin-csv-exports.ts` already lives under the
 * `registerAdminOpenApi` factory) so the cashback-config CSV
 * route lives separately from the JSON read surface.
 *
 * Path in the slice:
 *   - GET /api/admin/merchant-cashback-configs.csv
 *
 * No locally-scoped registered schemas — the response uses an
 * inline `z.string()` shape since CSV is text/csv. Only
 * `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the cashback-config CSV path on the supplied registry.
 * Called once from `registerAdminCashbackConfigOpenApi`.
 */
export function registerAdminCashbackConfigCsvOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs.csv',
    summary: 'CSV export of merchant cashback-split configs (ADR 011 / 018).',
    description:
      "Tier-3 bulk export per ADR 018 — finance / audit consumes the snapshot in a spreadsheet. Columns: merchant_id, merchant_name, wholesale_pct, user_cashback_pct, loop_margin_pct, active, updated_by, updated_at. Merchant-name falls back to merchant_id for rows whose merchant has evicted from the catalog (ADR 021 Rule A). Active serialises as the literal 'true' / 'false' so spreadsheet filters don't fight blanks. RFC 4180 (CRLF + quote-escape). Row cap 10 000 with a trailing `__TRUNCATED__` row on overflow — practically unreachable here (~hundreds of configs) but kept uniform with the other admin CSVs. 10/min rate limit.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV snapshot of all cashback-config rows',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              example:
                'merchant_id,merchant_name,wholesale_pct,user_cashback_pct,loop_margin_pct,active,updated_by,updated_at\r\namazon,Amazon,70.00,25.00,5.00,true,admin-abc,2026-04-22T14:00:00.000Z\r\n',
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
        description: 'Internal error building the CSV',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
