/**
 * Admin credit-side CSV-export OpenAPI registrations
 * (ADR 009 / 018 Tier-3).
 *
 * Lifted out of `apps/backend/src/openapi/admin-fleet-monthly.ts`
 * so the two credit-ledger CSV exports sit together separate from
 * the dozen aggregate / drill paths in the parent file:
 *
 *   - GET /api/admin/user-credits.csv                            (per-(user, currency) balances)
 *   - GET /api/admin/users/{userId}/credit-transactions.csv      (one-user ledger window)
 *
 * Both expose the credit-ledger surface in CSV form for finance /
 * legal / support workflows. They share the
 * `Cache-Control: private, no-store` + `Content-Disposition:
 * attachment` PII-safety convention and the 10 000-row
 * `__TRUNCATED__` sentinel.
 *
 * Re-invoked from `registerAdminFleetMonthlyOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/user-credits.csv` and
 * `/api/admin/users/{userId}/credit-transactions.csv` on the
 * supplied registry.
 */
export function registerAdminCreditCsvsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/user-credits.csv',
    summary: 'CSV export of user_credits balances (ADR 009).',
    description:
      'One row per `(user_id, currency)` credit balance, joined to `users.email`. Finance uses this to audit total off-chain liability per currency or to pull a list of balance-holders. Ordered by currency then balance desc so a "top holders" audit is the natural read order. Row cap 10 000 with `__TRUNCATED__` sentinel. `Cache-Control: private, no-store` (PII: email) + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header row: `User ID, Email, Currency, Balance (minor), Updated at (UTC)`. Balance emitted as bigint-string to preserve precision.',
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
        description: 'Rate limit exceeded (20/min per IP)',
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
    path: '/api/admin/users/{userId}/credit-transactions.csv',
    summary: "CSV export of one user's credit-transactions ledger (ADR 009).",
    description:
      'Full credit-ledger stream for a single user in a window — support / legal use it for a user dispute or a subject-access-request. Default window is 366 days; pass `?since=<iso-8601>` to override (cap 366 days). Row cap 10 000 with `__TRUNCATED__` sentinel. `Cache-Control: private, no-store` + `Content-Disposition: attachment; filename="credit-transactions-<userTail>-<date>.csv"`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'Header row: `id, type, amount_minor, currency, reference_type, reference_id, created_at`. bigint-as-string for amount_minor; ISO-8601 for created_at.',
            }),
          },
        },
      },
      400: {
        description: 'Malformed userId, invalid `since`, or window over 366 days',
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
