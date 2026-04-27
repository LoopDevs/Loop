/**
 * Admin order-cluster OpenAPI registrations
 * (ADR 010 / 011 / 015 / 019).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts`. Four paths
 * that back the Loop-native order surfaces in the admin panel:
 *
 *   - GET /api/admin/orders/activity              (created/fulfilled sparkline)
 *   - GET /api/admin/orders/payment-method-share  (ADR 015 flywheel KPI)
 *   - GET /api/admin/orders/{orderId}             (single-order drill)
 *   - GET /api/admin/orders/{orderId}/payout      (nested payout lookup)
 *
 * Locally-scoped order schemas travel with the slice (none
 * referenced anywhere else in admin.ts):
 *
 *   - `AdminOrderState`            (inline z.enum, not registered)
 *   - `AdminOrderPaymentMethod`    (inline z.enum, not registered)
 *   - `AdminOrderView`             (registered)
 *
 * Two deps cross the boundary:
 *
 *   - `errorResponse` (shared component from openapi.ts)
 *   - `adminPayoutView` — the orders/{id}/payout response shape is
 *     the same `AdminPayoutView` used by /api/admin/payouts*. The
 *     schema stays in admin.ts because it has multiple call-site
 *     consumers; threading it as a parameter keeps both sides
 *     pointing at the same registered schema instance — same
 *     pattern as the `adminWriteAudit` threading in #1166/#1175 and
 *     `adminSupplierSpendRow` threading in #1172/#1173.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the order-cluster paths + their locally-scoped
 * schemas on the supplied registry. Called once from
 * `registerAdminOpenApi`.
 */
export function registerAdminOrderClusterOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  adminPayoutView: ReturnType<OpenAPIRegistry['register']>,
): void {
  const AdminPayoutView = adminPayoutView;

  // ─── Admin — Loop-native order view (ADR 011 / 015) ─────────────────────────

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
    path: '/api/admin/orders/activity',
    summary: 'Per-day orders created/fulfilled sparkline (ADR 010 / 019 Tier 1).',
    description:
      "Last `?days=<N>` (default 7, clamped [1, 90]) of orders created vs fulfilled, UTC-bucketed. Uses `generate_series` + LEFT JOIN so every day in the window appears with zero-filled counts even when no orders crossed on that day — the UI doesn't gap-fill. Oldest-first so a bar chart renders left-to-right without a client-side reverse.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).optional().openapi({
          description: 'Window size in calendar days. Default 7, clamped [1, 90].',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Activity series',
        content: {
          'application/json': {
            schema: z.object({
              windowDays: z.number().int().min(1).max(90),
              days: z.array(
                z.object({
                  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  created: z.number().int().nonnegative(),
                  fulfilled: z.number().int().nonnegative(),
                }),
              ),
            }),
          },
        },
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
        description: 'Internal error reading activity',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/admin/orders/payment-method-share',
    summary: 'Payment-method share across orders (ADR 010 / 015).',
    description:
      "The cashback-flywheel metric. Single GROUP BY over `orders.payment_method`, zero-filled across every `ORDER_PAYMENT_METHODS` value so a method with no rows still renders as `{ orderCount: 0, chargeMinor: '0' }`. Default `?state=fulfilled` so in-flight orders don't skew the mix while users are still on the checkout page; pass any other `OrderState` to track a different bucket. `totalOrders` is echoed so the UI can render shares without re-summing. A rising `loop_asset` share is the signal ADR 015's cashback-recycle flywheel is working.",
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        state: z
          .enum(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'])
          .optional(),
      }),
    },
    responses: {
      200: {
        description: 'Payment-method share snapshot',
        content: {
          'application/json': {
            schema: z.object({
              state: z.enum([
                'pending_payment',
                'paid',
                'procuring',
                'fulfilled',
                'failed',
                'expired',
              ]),
              totalOrders: z.number().int().min(0),
              byMethod: z.record(
                z.enum(['xlm', 'usdc', 'credit', 'loop_asset']),
                z.object({
                  orderCount: z.number().int().min(0),
                  chargeMinor: z.string(),
                }),
              ),
            }),
          },
        },
      },
      400: {
        description: 'Invalid state',
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
        description: 'Internal error computing the share',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

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
