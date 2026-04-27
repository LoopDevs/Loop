/**
 * Admin raw-row CSV-export OpenAPI registrations
 * (ADR 015 / 017 / 018 Tier-3).
 *
 * Lifted out of `apps/backend/src/openapi/admin-csv-exports.ts` so
 * the three "raw row dump" exports — `pending_payouts`,
 * `admin_idempotency_keys` audit-tail, and `orders` — sit together
 * separate from the cashback / payouts / merchant / supplier /
 * treasury *activity-rolling aggregate* exports in the parent file.
 *
 * Shape parity across the three paths:
 *   - `?since=<iso-8601>` query (31-day default, 366-day cap)
 *   - RFC 4180 CSV body, 10 000-row cap with `__TRUNCATED__` sentinel
 *   - 200 / 400 / 401 / 403 / 429 / 500 declared
 *   - 10/min per-IP rate limit (Tier-3 finance pull)
 *   - `Cache-Control: private, no-store` + `Content-Disposition:
 *     attachment` set by the handler
 *
 * Re-invoked from `registerAdminCsvExportsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/payouts.csv`, `/api/admin/audit-tail.csv`,
 * and `/api/admin/orders.csv` on the supplied registry.
 */
export function registerAdminCsvExportsRawRowsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/payouts.csv',
    summary: 'CSV export of pending_payouts (ADR 015).',
    description:
      'Finance-ready CSV of pending_payouts rows in a time window — monthly reconciliation against the Stellar ledger. Default window is 31 days; pass `?since=<iso-8601>` to override. Capped at 366 days and 10 000 rows — past 10 000, the response emits a trailing `__TRUNCATED__` sentinel row and log-warns the real rowCount. `Cache-Control: private, no-store` + `Content-Disposition: attachment` so the browser drops it straight to disk.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
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
                'CRLF-terminated lines. Header row lists every pending_payouts column; each subsequent row emits RFC 4180-escaped values. bigint-as-string for amount_stroops; ISO-8601 for all timestamps.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/audit-tail.csv',
    summary: 'CSV export of admin write-audit trail (ADR 017 / 018).',
    description:
      'Finance / legal CSV of `admin_idempotency_keys` rows in a time window, joined to `users` for the actor email. SOC-2 / compliance export: a neutral-format dump of "who did what, when" that ops can hand to auditors without exposing the stored response bodies. Default window 31 days, capped at 366. Row cap 10 000 — past the cap, a trailing `__TRUNCATED__` sentinel row signals the window needs narrowing (and the handler log-warns the real rowCount). `Cache-Control: private, no-store` + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
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
                'CRLF-terminated lines. Header row: actor_user_id, actor_email, method, path, status, idempotency_key, created_at. ISO-8601 for the timestamp; response bodies intentionally omitted.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders.csv',
    summary: 'CSV export of Loop-native orders (ADR 011 / 015).',
    description:
      'Finance-ready CSV of `orders` rows in a time window. Month-end reconciliation: face-value totals against the CTX invoice, user-cashback totals against the ledger accrual feed, loop-margin totals against P&L. Default window 31 days, capped at 366 days. Row cap 10 000 — past that, a `__TRUNCATED__` sentinel row trails the output and the handler log-warns the real rowCount. Gift-card fields (redeem_code / redeem_pin / redeem_url) are omitted — this export is for reconciliation, not redemption.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
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
                'CRLF-terminated lines. Header row lists every exposed orders column; each subsequent row emits RFC 4180-escaped values. bigint-as-string for all `*_minor` columns; ISO-8601 for all timestamps.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `since` or window over 366 days',
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
