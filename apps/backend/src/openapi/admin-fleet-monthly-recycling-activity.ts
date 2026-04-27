/**
 * Admin recycling-activity OpenAPI registrations
 * (ADR 015 / 018).
 *
 * Lifted out of `apps/backend/src/openapi/admin-fleet-monthly.ts`
 * so the two flywheel-active-user surfaces sit together separate
 * from the dozen other monthly / activity / drill paths in the
 * parent file:
 *
 *   - GET /api/admin/users/recycling-activity.csv  (per-user CSV dump)
 *   - GET /api/admin/users/recycling-activity      (top-N ranked JSON)
 *
 * The two paths cover the same concept — users currently active in
 * the LOOP-asset cashback flywheel — but with different shapes:
 * the CSV is the row-dump for off-platform analysis (default 31
 * days, cap 366, 10k rows), the JSON is the top-N ranked-recent
 * view for the admin dashboard (default 25, cap 100). They share
 * the "Cache-Control: private, no-store" PII-safety convention.
 *
 * Re-invoked from `registerAdminFleetMonthlyOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/users/recycling-activity.csv` and
 * `/api/admin/users/recycling-activity` on the supplied registry.
 */
export function registerAdminRecyclingActivityOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/recycling-activity.csv',
    summary: 'CSV export of per-user recycling activity (ADR 015).',
    description:
      'One row per user in the fleet-wide flywheel view: total charge, recycled charge, cashback, order counts, and most-recent activity timestamp. Default window is 31 days; pass `?days=N` to override (cap 366). Row cap 10 000 with `__TRUNCATED__` sentinel. `Cache-Control: private, no-store` (PII: user ids + emails) + `Content-Disposition: attachment`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
      }),
    },
    responses: {
      200: {
        description: 'RFC 4180 CSV body',
        content: {
          'text/csv': {
            schema: z.string().openapi({
              description:
                'CRLF-terminated. Header row lists every recycling-activity column; bigint charges emitted as strings to survive JSON round-trips in downstream tooling.',
            }),
          },
        },
      },
      400: {
        description: 'Invalid `days` (out of range 1..366)',
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

  // A2-506 residual — JSON variant of recycling-activity. The CSV
  // shipped its registration; the JSON-returning sibling at
  // `app.ts:1585` was missed in the original wave.
  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/recycling-activity',
    summary: 'Top-N most-recent flywheel-active users (ADR 015).',
    description:
      'Ranked list of users who have placed at least one `loop_asset` paid order in the rolling 90-day window, ordered by most-recent recycle. Zero-recycle users are omitted (the signal is "who is in the loop", not the full directory). `?limit=` clamp 1..100, default 25. `Cache-Control: private, no-store` (per-user data).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Recycling-activity rows',
        content: {
          'application/json': {
            schema: z
              .object({
                since: z.string().openapi({ format: 'date-time' }),
                rows: z.array(
                  z.object({
                    userId: z.string(),
                    email: z.string(),
                    lastRecycledAt: z.string().openapi({ format: 'date-time' }),
                    recycledOrderCount: z.number().int().nonnegative(),
                    recycledChargeMinor: z.string().openapi({
                      description:
                        'Bigint-as-string — sum of charge_minor over loop_asset orders in window.',
                    }),
                    currency: z.string(),
                  }),
                ),
              })
              .openapi('AdminUsersRecyclingActivityResponse'),
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
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
