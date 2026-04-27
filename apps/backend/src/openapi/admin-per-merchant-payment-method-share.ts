/**
 * Admin per-merchant payment-method-share OpenAPI registration
 * (ADR 010 / 015).
 *
 * Lifted out of `./admin-per-merchant-drill.ts`. The merchant-
 * scoped rail-mix endpoint is the only path in the per-merchant
 * drill that owns the `PaymentMethodBucketShape` inline shape;
 * pulling it into its own slice keeps the parent file focused on
 * the cashback-flywheel scalars (flywheel-stats / cashback-summary)
 * + the time-series companion (cashback-monthly).
 *
 * Path in the slice:
 *   - GET /api/admin/merchants/{merchantId}/payment-method-share
 *
 * One locally-scoped schema travels with it:
 *   - `MerchantPaymentMethodShareResponse` (with the inline
 *     `PaymentMethodBucketShape` constant)
 *
 * Only `errorResponse` crosses the boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the merchant-scoped rail-mix path + its locally-scoped
 * schema on the supplied registry. Called once from
 * `registerAdminPerMerchantDrillOpenApi`.
 */
export function registerAdminPerMerchantPaymentMethodShareOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const PaymentMethodBucketShape = z.object({
    orderCount: z.number().int(),
    chargeMinor: z.string().openapi({
      description: 'SUM(charge_minor) for this (state, method) bucket. bigint-as-string.',
    }),
  });

  const MerchantPaymentMethodShareResponse = registry.register(
    'MerchantPaymentMethodShareResponse',
    z.object({
      merchantId: z.string(),
      state: z.enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
      totalOrders: z.number().int(),
      byMethod: z
        .object({
          xlm: PaymentMethodBucketShape,
          usdc: PaymentMethodBucketShape,
          credit: PaymentMethodBucketShape,
          loop_asset: PaymentMethodBucketShape,
        })
        .openapi({
          description:
            'Zero-filled across every known ORDER_PAYMENT_METHODS value so the admin UI layout stays stable across merchants with incomplete rail coverage.',
        }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/payment-method-share',
    summary: 'Per-merchant rail mix (ADR 010 / 015).',
    description:
      'Drives the "rail mix" card on the merchant drill. Merchant-scoped mirror of /api/admin/orders/payment-method-share — same zero-filled byMethod shape, filtered via WHERE merchant_id = :merchantId. Default ?state=fulfilled.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: 'Per-merchant rail mix',
        content: { 'application/json': { schema: MerchantPaymentMethodShareResponse } },
      },
      400: {
        description: 'Malformed merchantId or invalid ?state',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'DB error',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
