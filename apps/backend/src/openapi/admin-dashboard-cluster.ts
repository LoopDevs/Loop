/**
 * Admin dashboard-cluster OpenAPI registrations
 * (ADR 009 / 011 / 013 / 015 / 016).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Six paths
 * that read together as the operational + flywheel signals on the
 * /admin landing page:
 *
 *   - GET /api/admin/stuck-orders                  (SLO red flag)
 *   - GET /api/admin/stuck-payouts                 (SLO red flag)
 *   - GET /api/admin/cashback-activity             (daily series)
 *   - GET /api/admin/cashback-realization          (KPI snapshot)
 *   - GET /api/admin/cashback-realization/daily    (drift series)
 *   - GET /api/admin/merchant-stats                (per-merchant)
 *
 * Twelve locally-scoped schemas travel with the slice (none
 * referenced anywhere else in admin.ts):
 *
 *   - MerchantStatsRow / Response
 *   - AdminActivityPerCurrency, CashbackActivityDay /
 *     CashbackActivityResponse
 *   - CashbackRealizationRow / Response,
 *     CashbackRealizationDay / DailyResponse
 *   - StuckOrderRow / StuckOrdersResponse
 *   - StuckPayoutRow / StuckPayoutsResponse
 *
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminDashboardStuckRowsOpenApi } from './admin-dashboard-cluster-stuck-rows.js';

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

  // ─── Admin — cashback realization (ADR 009 / 015) ──────────────────────────

  const CashbackRealizationRow = registry.register(
    'CashbackRealizationRow',
    z.object({
      currency: z.string().length(3).nullable().openapi({
        description: 'ISO 4217 code; `null` for the fleet-wide aggregate row.',
      }),
      earnedMinor: z.string(),
      spentMinor: z.string(),
      withdrawnMinor: z.string(),
      outstandingMinor: z.string(),
      recycledBps: z.number().int().nonnegative().max(10_000).openapi({
        description: 'spent / earned, as basis points (10 000 = 100.00%).',
      }),
    }),
  );

  const CashbackRealizationResponse = registry.register(
    'CashbackRealizationResponse',
    z.object({ rows: z.array(CashbackRealizationRow) }),
  );

  const CashbackRealizationDay = registry.register(
    'CashbackRealizationDay',
    z.object({
      day: z.string().openapi({ description: 'ISO date (YYYY-MM-DD).' }),
      currency: z.string().length(3),
      earnedMinor: z.string(),
      spentMinor: z.string(),
      recycledBps: z.number().int().nonnegative().max(10_000),
    }),
  );

  const CashbackRealizationDailyResponse = registry.register(
    'CashbackRealizationDailyResponse',
    z.object({
      days: z.number().int().min(1).max(180),
      rows: z.array(CashbackRealizationDay),
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization',
    summary: 'Cashback realization rate — the flywheel-health KPI (ADR 009 / 015).',
    description:
      'Per-currency + fleet-wide aggregate of lifetime cashback emitted, spent on new Loop orders, withdrawn off-ledger, plus outstanding off-chain liability. `recycledBps = spent / earned × 10 000` — the share of emitted cashback that has flowed back into new orders. High realization = flywheel turning; low realization = cashback sitting as stagnant liability. Zero-earned currencies are omitted from per-currency rows but the aggregate row always ships (`currency: null`).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Per-currency rows + a fleet-wide aggregate',
        content: { 'application/json': { schema: CashbackRealizationResponse } },
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

  registry.registerPath({
    method: 'get',
    path: '/api/admin/cashback-realization/daily',
    summary: 'Daily cashback-realization trend (ADR 009 / 015).',
    description:
      "Drift-over-time companion to `/api/admin/cashback-realization`. Per-(day, currency) rows with `earnedMinor`, `spentMinor`, and `recycledBps`. `generate_series` LEFT JOIN emits every day in the window even when zero cashback was earned or spent (so sparkline x-axis doesn't compress on gaps). Window: `?days=30` default, 1..180 clamp.",
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
        content: { 'application/json': { schema: CashbackRealizationDailyResponse } },
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
