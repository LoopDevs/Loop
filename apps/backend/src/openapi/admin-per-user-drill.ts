/**
 * Admin per-user drill OpenAPI registrations
 * (ADR 009 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. Per-user axis of the ADR-022 triplet
 * pattern — the per-merchant axis lives in
 * `./admin-per-merchant-drill.ts`. This slice covers the three
 * scalars that back the `/admin/users/:id` drill page: flywheel
 * stats, cashback-monthly, payment-method-share.
 *
 * Carries 4 locally-scoped schemas with the slice:
 *
 *   - `AdminUserFlywheelStats`
 *   - `AdminUserCashbackMonthlyEntry`
 *   - `AdminUserCashbackMonthlyResponse`
 *   - `UserPaymentMethodShareResponse` (+ inline
 *     `PaymentMethodBucketShape` constant — declared
 *     byte-identically here and in the per-merchant slice
 *     because the spec needs both shapes to match)
 *
 * None of those names are referenced anywhere else in admin.ts.
 * Only `errorResponse` crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the per-user drill paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminPerUserDrillOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminUserCashbackMonthlyEntry = registry.register(
    'AdminUserCashbackMonthlyEntry',
    z.object({
      month: z.string().openapi({ description: '"YYYY-MM" in UTC.' }),
      currency: z.string().length(3),
      cashbackMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  const AdminUserCashbackMonthlyResponse = registry.register(
    'AdminUserCashbackMonthlyResponse',
    z.object({
      userId: z.string().uuid(),
      entries: z.array(AdminUserCashbackMonthlyEntry),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/cashback-monthly',
    summary: 'Per-user 12-month cashback emission trend (ADR 009/015).',
    description:
      'Admin-scoped per-user sibling of /api/admin/cashback-monthly. 12-month window on credit_transactions of type=cashback. Existence probe separates 404 (unknown userId) from empty entries[] (exists, no cashback in window).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ userId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Per-(month, currency) cashback for the user',
        content: { 'application/json': { schema: AdminUserCashbackMonthlyResponse } },
      },
      400: {
        description: 'Malformed userId',
        content: { 'application/json': { schema: errorResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'User not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });
}
