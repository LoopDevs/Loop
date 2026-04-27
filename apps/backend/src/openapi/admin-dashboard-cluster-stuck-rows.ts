/**
 * Admin dashboard stuck-row OpenAPI registrations
 * (ADR 011 / 013 / 015 / 016).
 *
 * Lifted out of `apps/backend/src/openapi/admin-dashboard-cluster.ts`
 * so the two SLO red-flag paths — `/api/admin/stuck-orders` and
 * `/api/admin/stuck-payouts` — and their four locally-scoped row /
 * response schemas live together separate from the cashback / merchant
 * aggregate paths in the parent file.
 *
 * The two paths share the same query shape (`thresholdMinutes` +
 * `limit`), the same response envelope (`{ thresholdMinutes, rows }`),
 * and the same five response codes (200/401/403/429/500). They sit
 * side-by-side on the admin dashboard as the "is the fleet stuck?"
 * pair, so keeping their schemas + paths in one focused module
 * mirrors the operator's mental model.
 *
 * Re-invoked from `registerAdminDashboardClusterOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/stuck-orders` and `/api/admin/stuck-payouts`
 * plus their four locally-scoped schemas on the supplied registry.
 */
export function registerAdminDashboardStuckRowsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin — stuck-orders triage ───────────────────────────────────────────

  const StuckOrderRow = registry.register(
    'StuckOrderRow',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      merchantId: z.string(),
      state: z.enum(['paid', 'procuring']),
      stuckSince: z.string().datetime(),
      ageMinutes: z.number().int().min(0),
      ctxOrderId: z.string().nullable(),
      ctxOperatorId: z.string().nullable(),
    }),
  );

  const StuckOrdersResponse = registry.register(
    'StuckOrdersResponse',
    z.object({
      thresholdMinutes: z.number().int().min(1),
      rows: z.array(StuckOrderRow),
    }),
  );

  // ─── Admin — stuck payouts (ADR 015 / 016) ─────────────────────────────────

  const StuckPayoutRow = registry.register(
    'StuckPayoutRow',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      orderId: z.string().uuid(),
      assetCode: z.string(),
      amountStroops: z.string(),
      state: z.string(),
      stuckSince: z.string().datetime(),
      ageMinutes: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
    }),
  );

  const StuckPayoutsResponse = registry.register(
    'StuckPayoutsResponse',
    z.object({
      thresholdMinutes: z.number().int().min(1),
      rows: z.array(StuckPayoutRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/stuck-orders',
    summary: 'Orders stuck in paid/procuring past a threshold (ADR 011 / 013).',
    description:
      'Returns non-terminal orders (state `paid` or `procuring`) older than `?thresholdMinutes=` (default 5, max 10 080). Admin dashboard polls this as its SLO red-flag card — any row landing here means the CTX procurement worker is lagging or an upstream call is hung. Fulfilled / failed / expired rows are terminal and never appear.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        thresholdMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Stuck rows (oldest first) plus the threshold used',
        content: { 'application/json': { schema: StuckOrdersResponse } },
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the table',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/stuck-payouts',
    summary: 'Payouts stuck in pending/submitted past a threshold (ADR 015 / 016).',
    description:
      "Parallel to `/api/admin/stuck-orders`: returns `pending_payouts` rows in non-terminal state (`pending` or `submitted`) older than `?thresholdMinutes=` (default 5, max 10 080). Ops dashboards poll this alongside stuck-orders — a stuck `submitted` row usually means the Horizon confirmation watcher hasn't seen the tx land. Failed rows are deliberately excluded (they're terminal; review at `/api/admin/payouts?state=failed`).",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        thresholdMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Stuck rows (oldest first) plus the threshold used',
        content: { 'application/json': { schema: StuckPayoutsResponse } },
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the table',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
