/**
 * Admin per-merchant cashback-config history OpenAPI registration
 * (ADR 011).
 *
 * Lifted out of `apps/backend/src/openapi/admin-cashback-config.ts`
 * so the per-merchant audit-log surface plus its two locally-scoped
 * schemas live together separate from the CRUD + fleet-history
 * paths in the parent file:
 *
 *   - GET /api/admin/merchant-cashback-configs/{merchantId}/history
 *
 * Locally-scoped schemas (none referenced elsewhere in the parent —
 * the fleet-wide `/history` path uses an inline `z.object` literal
 * with a richer per-row shape that includes the resolved merchant
 * name, so it deliberately doesn't share these registrations):
 *   - `AdminCashbackConfigHistoryRow`
 *   - `AdminCashbackConfigHistoryResponse`
 *
 * `cashbackPctString` is the shared `numeric(5,2)`-as-string
 * percentage shape — threaded in from the parent so the registered
 * schema instance stays shared with the rest of the cashback-config
 * surface.
 *
 * Re-invoked from `registerAdminCashbackConfigOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/merchant-cashback-configs/{merchantId}/history`
 * plus its two locally-scoped schemas on the supplied registry.
 */
export function registerAdminCashbackConfigHistoryOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  cashbackPctString: z.ZodTypeAny,
): void {
  const CashbackPctString = cashbackPctString;

  const AdminCashbackConfigHistoryRow = registry.register(
    'AdminCashbackConfigHistoryRow',
    z.object({
      id: z.string().uuid(),
      merchantId: z.string(),
      wholesalePct: CashbackPctString,
      userCashbackPct: CashbackPctString,
      loopMarginPct: CashbackPctString,
      active: z.boolean(),
      changedBy: z.string().openapi({
        description: 'Admin user id that triggered the prior-row snapshot.',
      }),
      changedAt: z.string().datetime(),
    }),
  );

  const AdminCashbackConfigHistoryResponse = registry.register(
    'AdminCashbackConfigHistoryResponse',
    z.object({ history: z.array(AdminCashbackConfigHistoryRow) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchant-cashback-configs/{merchantId}/history',
    summary: 'Audit-log history for one merchant cashback config (ADR 011).',
    description:
      'Up to 50 most-recent prior-state snapshots for a single merchant, newest first. Each row captures the exact values at the time of the change and who made it.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
    },
    responses: {
      200: {
        description: 'History rows (bounded to 50)',
        content: { 'application/json': { schema: AdminCashbackConfigHistoryResponse } },
      },
      400: {
        description: 'Missing merchantId',
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
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
