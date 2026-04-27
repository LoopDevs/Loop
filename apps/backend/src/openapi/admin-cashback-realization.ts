/**
 * Admin cashback-realization OpenAPI registrations
 * (ADR 009 / 015).
 *
 * Lifted out of `./admin-dashboard-cluster.ts`. The two
 * realization paths read together as the flywheel-health KPI:
 *
 *   - GET /api/admin/cashback-realization        (per-currency
 *     + fleet-wide snapshot of `recycledBps = spent / earned`)
 *   - GET /api/admin/cashback-realization/daily  (per-day
 *     drift companion for the dashboard sparkline)
 *
 * Co-locating them isolates the realization concept from the rest
 * of the dashboard cluster (stuck rows, cashback-activity,
 * merchant-stats) — every schema in this slice carries the
 * `recycledBps` semantics and shares the "earned vs spent" framing.
 *
 * Four locally-scoped schemas travel with the slice:
 *   - `CashbackRealizationRow` / `CashbackRealizationResponse`
 *     (snapshot)
 *   - `CashbackRealizationDay` / `CashbackRealizationDailyResponse`
 *     (drift series)
 *
 * Only `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the realization paths + their locally-scoped schemas
 * on the supplied registry. Called once from
 * `registerAdminDashboardClusterOpenApi`.
 */
export function registerAdminCashbackRealizationOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — cashback-realization rate (ADR 009 / 015) ─────────────────────

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
}
