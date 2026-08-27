/**
 * Admin CTX operator-commission OpenAPI registration (ctx-interop).
 *
 * Path in the slice:
 *   - GET /api/admin/ctx-commission
 *
 * Locally-scoped schemas travel with the slice:
 *   - `AdminCtxCommissionBalance`
 *   - `AdminCtxCommissionSettlement`
 *   - `AdminCtxCommissionResponse`
 *
 * Amounts are MAJOR-unit decimal strings exactly as CTX returns them
 * (see `@loop/shared/admin-ctx-commission.ts` for the rationale) —
 * deliberately not Loop's bigint-minor convention.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the ctx-commission path + its locally-scoped schemas on
 * the supplied registry. Called once from `registerAdminOpenApi`.
 */
export function registerAdminCtxCommissionOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminCtxCommissionBalance = registry.register(
    'AdminCtxCommissionBalance',
    z.object({
      currency: z.string(),
      amount: z.string().openapi({ description: 'Major-unit decimal string as returned by CTX.' }),
      entryCount: z.number().int().min(0),
    }),
  );

  const AdminCtxCommissionSettlement = registry.register(
    'AdminCtxCommissionSettlement',
    z.object({
      id: z.string(),
      amount: z.string().openapi({ description: 'Major-unit decimal string as returned by CTX.' }),
      currency: z.string(),
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
      giftCardIds: z.array(z.string()),
      entryCount: z.number().int().min(0),
      created: z.string().datetime(),
    }),
  );

  const AdminCtxCommissionResponse = registry.register(
    'AdminCtxCommissionResponse',
    z.object({
      configured: z.boolean().openapi({
        description:
          'false when the CTX API credentials are unset — a deployment state, not an error; every other field is absent. The company id is resolved from CTX GET /me, not configured.',
      }),
      companyId: z.string().optional(),
      balances: z.array(AdminCtxCommissionBalance).optional(),
      lastSettlementAt: z.string().optional(),
      settlements: z.array(AdminCtxCommissionSettlement).optional(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/ctx-commission',
    summary: 'CTX operator-commission balance + recent settlements (ctx-interop).',
    description:
      "Proxies CTX's `GET /companies/:id/commission` and `.../commission/settlements` using Loop's operator API credentials, resolving Loop's company id from CTX `GET /me` (cached per process). CTX's record of the commission it owes Loop for attributed orders — the reconciliation counterpart to `/api/admin/supplier-spend` (Loop's own record of the same traffic). Returns `{ configured: false }` when the CTX API credentials are unset.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Commission balances + recent settlements (or `configured: false`)',
        content: { 'application/json': { schema: AdminCtxCommissionResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description:
          'Not found — also returned to authenticated non-staff callers: requireStaff masks the admin surface as 404 by design (see src/auth/require-staff.ts).',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (30/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      502: {
        description: 'CTX unreachable or returned an invalid response',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error (unhandled — mapped by app.onError)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
