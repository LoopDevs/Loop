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
  // ─── Admin per-user drill metrics (ADR 009/015/022) ────────────────────────
  //
  // Per-user axis of the triplet pattern — recovers content from the
  // auto-closed #670 (its stacked base branch was deleted during cascade
  // merge) plus ships the batch 4 CSV siblings and the fleet payouts pair
  // in one coherent PR.

  const AdminUserFlywheelStats = registry.register(
    'AdminUserFlywheelStats',
    z.object({
      userId: z.string().uuid(),
      currency: z.string().length(3).openapi({
        description:
          "Target user's home_currency — both numerator and denominator share it so the ratio has a coherent denomination.",
      }),
      recycledOrderCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      totalFulfilledCount: z.number().int(),
      totalFulfilledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/flywheel-stats',
    summary: 'Per-user recycled-vs-total scalar (ADR 015).',
    description:
      "Admin-scoped mirror of /api/users/me/flywheel-stats. 404 on unknown userId (distinguishes 'user not in DB' from 'user with no fulfilled orders' which returns zeroed counts). Home-currency-locked.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ userId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Per-user flywheel scalar',
        content: { 'application/json': { schema: AdminUserFlywheelStats } },
      },
      400: {
        description: 'Malformed userId',
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

  // Inline shape — `PaymentMethodBucketShape` was previously
  // declared once for both the per-merchant and per-user drill
  // sections. The per-merchant slice now lives in
  // ./admin-per-merchant-drill.ts with its own copy; this declaration
  // is the per-user-side replica so per-user can stand alone here.
  // Both copies must be byte-identical or the spec will drift.
  const PaymentMethodBucketShape = z.object({
    orderCount: z.number().int(),
    chargeMinor: z.string().openapi({
      description: 'SUM(charge_minor) for this (state, method) bucket. bigint-as-string.',
    }),
  });

  const UserPaymentMethodShareResponse = registry.register(
    'UserPaymentMethodShareResponse',
    z.object({
      userId: z.string().uuid(),
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
      totalOrders: z.number().int(),
      byMethod: z.object({
        xlm: PaymentMethodBucketShape,
        usdc: PaymentMethodBucketShape,
        credit: PaymentMethodBucketShape,
        loop_asset: PaymentMethodBucketShape,
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users/{userId}/payment-method-share',
    summary: 'Per-user rail mix (ADR 010/015).',
    description:
      'Admin-scoped per-user sibling of the per-merchant payment-method-share (#668). Default ?state=fulfilled. Zero-filled byMethod. Support-triage: "does this user only pay with LOOP asset?" vs "never touched it?".',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ userId: z.string().uuid() }),
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-user rail mix',
        content: { 'application/json': { schema: UserPaymentMethodShareResponse } },
      },
      400: {
        description: 'Malformed userId or invalid ?state',
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
