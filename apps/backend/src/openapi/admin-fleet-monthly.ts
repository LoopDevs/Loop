/**
 * Admin fleet-wide monthly / daily OpenAPI registrations
 * (ADR 015 / 016).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. This slice owns every fleet-wide
 * monthly + daily aggregate path (`/api/admin/payouts-monthly`,
 * `/api/admin/payouts-activity`, `/api/admin/cashback-monthly`,
 * `/api/admin/orders`, `/api/admin/orders/payment-method-activity`,
 * `/api/admin/merchants/flywheel-share` + the CSV companions, and
 * the single-user recycling-activity drills) plus the locally-
 * declared response schemas:
 *
 *   - `AdminPayoutsMonthlyEntry`
 *   - `AdminPayoutsMonthlyResponse`
 *   - `PerAssetPayoutAmount`
 *   - `PayoutsActivityDay`
 *   - `PayoutsActivityResponse`
 *
 * None of those schemas are referenced by the rest of admin.ts —
 * the slice carries them with it. Only `errorResponse` crosses
 * the boundary, passed in from `registerAdminOpenApi`.
 *
 * Several A2-506 paths in here use `z.unknown()` for their 200
 * body schema because the handler-side TypeScript interface is
 * the source of truth and a parity-pass is its own follow-up
 * task; that decision is preserved verbatim here so the spec
 * output is unchanged.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminMerchantsFlywheelOpenApi } from './admin-fleet-monthly-merchants-flywheel.js';
import { registerAdminPayoutsAggregatesOpenApi } from './admin-fleet-monthly-payouts.js';
import { registerAdminRecyclingActivityOpenApi } from './admin-fleet-monthly-recycling-activity.js';
import { registerAdminUserCashbackDrillOpenApi } from './admin-fleet-monthly-user-cashback-drill.js';

/**
 * Registers the fleet-wide monthly / daily admin paths + their
 * locally-scoped schemas on the supplied registry. Called once
 * from `registerAdminOpenApi`.
 */
export function registerAdminFleetMonthlyOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin fleet-wide monthly / daily (ADR 015/016) ─────────────────────────

  // The two confirmed-payout fleet aggregates
  // (`/api/admin/payouts-monthly` and
  // `/api/admin/payouts-activity`) plus their five locally-scoped
  // schemas live in `./admin-fleet-monthly-payouts.ts`. Same path-
  // registration position as the original block.
  registerAdminPayoutsAggregatesOpenApi(registry, errorResponse);

  // A2-506: 8 non-CSV admin endpoints were missing from the OpenAPI
  // surface. Each handler's own TypeScript response interface is the
  // authoritative wire shape; these registrations carry the route
  // identity, auth contract, and error ladder so generated clients
  // + the admin Swagger preview see them. The response schemas use
  // `z.unknown()` for the body payload — the TS interface in the
  // handler file is the source of truth for the row shape; OpenAPI
  // callers read the doc comment for column-level detail. A follow-up
  // could mirror each interface into a zod schema, but parity with
  // TS would need a single-source-of-truth machinery we don't have
  // today.

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders',
    summary: 'Paginated admin view of orders (ADR 010 / 018).',
    description:
      "Fleet-wide orders list for the admin drill. Supports `?state=`, `?merchantId=`, `?userId=`, `?before=<iso>`, `?limit=` (default 20, cap 100) for paging. Returns the orders alongside user/merchant context resolved server-side so the admin UI doesn't need per-row round-trips.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: z.string().optional(),
        merchantId: z.string().optional(),
        userId: z.string().uuid().optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Page of orders + pagination cursor',
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
    path: '/api/admin/orders/payment-method-activity',
    summary: 'Fleet payment-method-share activity per day (ADR 015 / 018).',
    description:
      'Daily bucketed counts and charge totals grouped by payment method (credit, loop_asset, usdc, xlm) — powers the rail-mix activity chart on /admin/cashback. Window: `?days=N` (default 30, cap 180).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-day payment-method activity',
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
    path: '/api/admin/cashback-monthly',
    summary: 'Fleet-wide monthly cashback aggregate (ADR 009 / 015).',
    description:
      'Monthly sum of cashback credited across all users in the last 12 months, grouped by currency. Drives the admin dashboard headline. Self-scoped — a user-drill variant lives at `/api/users/me/cashback-monthly`.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: '12-month cashback buckets',
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

  // The three merchants flywheel-share paths
  // (`/merchant-stats.csv`, `/merchants/flywheel-share`,
  // `/merchants/flywheel-share.csv`) live in
  // `./admin-fleet-monthly-merchants-flywheel.ts`. They share the
  // same `?days` window and use no admin-local schemas, so the
  // slice is fully self-contained behind `errorResponse`.
  registerAdminMerchantsFlywheelOpenApi(registry, errorResponse);

  // The two per-user cashback drill paths
  // (`/users/{userId}/cashback-by-merchant` and
  // `/users/{userId}/cashback-summary`) live in
  // `./admin-fleet-monthly-user-cashback-drill.ts`. Same
  // path-registration position as the original block.
  registerAdminUserCashbackDrillOpenApi(registry, errorResponse);

  // The two recycling-activity paths
  // (`/users/recycling-activity.csv` and
  // `/users/recycling-activity`) live in
  // `./admin-fleet-monthly-recycling-activity.ts`. Same
  // path-registration position as the original block.
  registerAdminRecyclingActivityOpenApi(registry, errorResponse);

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
