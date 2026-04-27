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
import { registerAdminCreditCsvsOpenApi } from './admin-fleet-monthly-credit-csvs.js';
import { registerAdminMerchantsFlywheelOpenApi } from './admin-fleet-monthly-merchants-flywheel.js';
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

  // The two credit-side CSV exports
  // (`/api/admin/user-credits.csv` and
  // `/api/admin/users/{userId}/credit-transactions.csv`) live in
  // `./admin-fleet-monthly-credit-csvs.ts`. Same
  // path-registration position as the original block.
  registerAdminCreditCsvsOpenApi(registry, errorResponse);
}
