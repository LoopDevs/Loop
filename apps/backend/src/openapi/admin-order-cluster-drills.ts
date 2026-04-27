/**
 * Admin per-order drill OpenAPI registrations
 * (ADR 010 / 011 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/admin-order-cluster.ts`
 * so the two `/api/admin/orders/{orderId}*` drills sit alongside
 * the `AdminOrderView` schema, separate from the orders aggregate
 * paths in the parent file:
 *
 *   - GET /api/admin/orders/{orderId}          (single-row drill)
 *   - GET /api/admin/orders/{orderId}/payout   (nested payout lookup)
 *
 * Both paths key off the same `orderId` UUID and form the
 * deep-link target from the orders list / activity views.
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `AdminOrderState` (inline z.enum)
 *   - `AdminOrderPaymentMethod` (inline z.enum)
 *   - `AdminOrderView`
 *
 * `adminPayoutView` is registered upstream in admin.ts (also
 * used by the payouts cluster); threaded into the new factory so
 * both consumers keep the same registered component instance —
 * same pattern as the parent file.
 *
 * Re-invoked from `registerAdminOrderClusterOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/admin/orders/{orderId}` and
 * `/api/admin/orders/{orderId}/payout` plus the `AdminOrderView`
 * schema on the supplied registry.
 */
export function registerAdminOrderClusterDrillsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminPayoutView: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminPayoutView = adminPayoutView;

  const AdminOrderState = z
    .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
    .openapi({ description: 'Mirrors the CHECK constraint on orders.state.' });

  const AdminOrderPaymentMethod = z.enum(['xlm', 'usdc', 'credit', 'loop_asset']);

  const AdminOrderView = registry.register(
    'AdminOrderView',
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      merchantId: z.string(),
      state: AdminOrderState,
      currency: z.string().length(3),
      faceValueMinor: z.string(),
      chargeCurrency: z.string().length(3),
      chargeMinor: z.string(),
      paymentMethod: AdminOrderPaymentMethod,
      wholesalePct: z.string(),
      userCashbackPct: z.string(),
      loopMarginPct: z.string(),
      wholesaleMinor: z.string(),
      userCashbackMinor: z.string(),
      loopMarginMinor: z.string(),
      ctxOrderId: z.string().nullable(),
      ctxOperatorId: z.string().nullable(),
      failureReason: z.string().nullable(),
      createdAt: z.string().datetime(),
      paidAt: z.string().datetime().nullable(),
      procuredAt: z.string().datetime().nullable(),
      fulfilledAt: z.string().datetime().nullable(),
      failedAt: z.string().datetime().nullable(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/{orderId}',
    summary: 'Single Loop-native order drill-down (ADR 011 / 015).',
    description:
      'Permalink view for one `orders` row. Admin UI deep-links each row from the list page to this endpoint so ops can quote an order id in a ticket or incident note. Gift-card fields (redeem_code / redeem_pin) are omitted — the admin view is for diagnosis, not redemption.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Order row',
        content: { 'application/json': { schema: AdminOrderView } },
      },
      400: {
        description: 'Missing or malformed orderId',
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
      404: {
        description: 'Order not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/{orderId}/payout',
    summary: 'Payout row for a given order (ADR 015).',
    description:
      'Nested lookup — given an order id, return the single `pending_payouts` row associated with it (UNIQUE on `order_id`). Used by the admin order drill-down to render payout state without a second round-trip. 404 when the order has no payout row yet (common: payout builder only runs once cashback is due).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ orderId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: 'Payout row',
        content: { 'application/json': { schema: AdminPayoutView } },
      },
      400: {
        description: 'Missing or malformed orderId',
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
      404: {
        description: 'No payout row for this order',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: {
        description: 'Internal error reading the row',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
