/**
 * Admin dashboard-cluster OpenAPI registrations
 * (ADR 009 / 011 / 013 / 015 / 016).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Six paths
 * that read together as the operational + flywheel signals on the
 * /admin landing page. Two are registered directly here; the
 * other four are fanned out to topical siblings:
 *
 *   - GET /api/admin/cashback-activity             (daily series)
 *   - GET /api/admin/merchant-stats                (per-merchant)
 *   - GET /api/admin/stuck-orders / stuck-payouts  →
 *     `./admin-dashboard-cluster-stuck-rows.ts`
 *   - GET /api/admin/cashback-realization{,/daily} →
 *     `./admin-cashback-realization.ts`
 *
 * Schemas registered directly here:
 *   - MerchantStatsRow / Response
 *   - AdminActivityPerCurrency, CashbackActivityDay /
 *     CashbackActivityResponse
 *
 * Sibling-owned schemas:
 *   - CashbackRealizationRow / Response, CashbackRealizationDay /
 *     DailyResponse — `./admin-cashback-realization.ts`
 *   - StuckOrderRow / StuckOrdersResponse, StuckPayoutRow /
 *     StuckPayoutsResponse — `./admin-dashboard-cluster-stuck-rows.ts`
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminDashboardStuckRowsOpenApi } from './admin-dashboard-cluster-stuck-rows.js';
import { registerAdminCashbackRealizationOpenApi } from './admin-cashback-realization.js';

/**
 * Registers the dashboard-cluster paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminDashboardClusterOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — per-merchant cashback stats (ADR 011 / 015) ───────────────────

  const MerchantStatsRow = registry.register(
    'MerchantStatsRow',
    z.object({
      merchantId: z.string(),
      currency: z.string().length(3),
      orderCount: z.number().int().min(0),
      faceValueMinor: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
      lastFulfilledAt: z.string().datetime(),
    }),
  );

  const MerchantStatsResponse = registry.register(
    'MerchantStatsResponse',
    z.object({
      since: z.string().datetime(),
      rows: z.array(MerchantStatsRow),
    }),
  );

  // ─── Admin — cashback-activity time-series (ADR 009 / 015) ─────────────────

  const AdminActivityPerCurrency = registry.register(
    'AdminActivityPerCurrency',
    z.object({
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
    }),
  );

  const CashbackActivityDay = registry.register(
    'CashbackActivityDay',
    z.object({
      day: z.string().openapi({ description: 'YYYY-MM-DD (UTC).' }),
      count: z.number().int().min(0),
      byCurrency: z.array(AdminActivityPerCurrency),
    }),
  );

  const CashbackActivityResponse = registry.register(
    'CashbackActivityResponse',
    z.object({
      days: z.number().int().min(1).max(180),
      rows: z.array(CashbackActivityDay),
    }),
  );

  // The two SLO red-flag paths (`/api/admin/stuck-orders` and
  // `/api/admin/stuck-payouts`) and their four locally-scoped row /
  // response schemas live in `./admin-dashboard-cluster-stuck-rows.ts`.
  // Registered here so the parent factory's path-registration order
  // is preserved.
  registerAdminDashboardStuckRowsOpenApi(registry, errorResponse);

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-activity',
    summary: 'Daily cashback-accrual time-series (ADR 009 / 015).',
    description:
      'Dense day-by-day series of cashback credit_transactions for the admin dashboard sparkline. Every day in the window has a row (zero-activity days emit `count: 0, byCurrency: []`). `?days=` overrides the default 30-day window, clamped 1..180.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily rows (oldest → newest)',
        content: { 'application/json': { schema: CashbackActivityResponse } },
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
      500: {
        description: 'Internal error computing the series',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Admin — cashback realization (ADR 009 / 015) ──────────────────────────
  //
  // The two realization paths (snapshot + daily drift) and their
  // four locally-scoped schemas live in
  // `./admin-cashback-realization.ts`. Co-located there so the
  // `recycledBps`/earned/spent framing reads as one slice — kept
  // out of the dashboard-cluster file so this one stays focused
  // on stuck rows, daily activity, and merchant-stats.
  registerAdminCashbackRealizationOpenApi(registry, errorResponse);

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-stats',
    summary: 'Per-merchant cashback stats (ADR 011 / 015).',
    description:
      "Groups fulfilled orders in the window by (merchant, currency). Each row carries order count, face-value total, wholesale cost, user cashback, loop margin, and the most-recent fulfilled timestamp. Sorted by `user_cashback_minor` descending — highest-cashback merchants surface first. Default window 31 days, capped at 366. Distinct from `/api/admin/supplier-spend`, which groups by currency only; this one is the 'which merchants drive the business' view.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        since: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant rows, highest cashback first',
        content: { 'application/json': { schema: MerchantStatsResponse } },
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
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error computing the aggregate',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
