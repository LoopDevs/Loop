/**
 * Admin treasury CSV-export OpenAPI registrations
 * (ADR 009 / 015 / 018 Tier-3).
 *
 * Lifted out of `apps/backend/src/openapi/admin-csv-exports.ts` so
 * the two treasury-shaped CSVs sit together separate from the
 * cashback / payouts / merchant / supplier / operators activity
 * exports in the parent file:
 *
 *   - GET /api/admin/treasury/credit-flow.csv   (daily × currency credit-flow)
 *   - GET /api/admin/treasury.csv               (point-in-time SOC-2 snapshot)
 *
 * Both fund the SOC-2 / audit-evidence story — the daily series
 * plus the point-in-time snapshot together let an auditor diff
 * successive evidence runs against the inflow/outflow drivers. The
 * snapshot path declares 401/403 explicitly (matches the pattern
 * inherited from the original treasury+payouts block, see
 * docstring comment in the parent file).
 *
 * Re-invoked from `registerAdminCsvExportsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/treasury/credit-flow.csv` and
 * `/api/admin/treasury.csv` on the supplied registry.
 */
export function registerAdminCsvExportsTreasuryOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/treasury/credit-flow.csv',
    summary: 'Daily × per-currency credit-flow CSV (ADR 009/015/018).',
    description:
      'Tier-3 CSV of /api/admin/treasury/credit-flow. Columns: day,currency,credited_minor,debited_minor,net_minor. Completes the finance-CSV quartet (cashback-activity, payouts-activity, supplier-spend/activity, this). Zero-activity days emit day,,0,0,0. With ?currency the LEFT JOIN generate_series gives a dense series. Row cap 10 000.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
        currency: z.enum(['USD', 'GBP', 'EUR']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
      },
      400: {
        description: 'Unknown `currency`',
        content: { 'application/json': { schema: errorResponse } },
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
    path: '/api/admin/treasury.csv',
    summary: 'Treasury snapshot CSV for SOC-2 / audit evidence (ADR 009/015/018).',
    description:
      'Point-in-time long-form CSV of the same aggregate /api/admin/treasury serves. Columns: metric,key,value. Metric vocabulary: snapshot_taken_at, outstanding, ledger_total, liability, liability_issuer, asset_stroops, payout_state, operator, operator_pool_size. Successive snapshots diff cleanly in audit tooling — auditors can eyeball which field moved between evidence runs. Reuses the JSON snapshot handler so no aggregate drift.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'CSV body',
        content: { 'text/csv; charset=utf-8': { schema: z.string() } },
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
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });
}
