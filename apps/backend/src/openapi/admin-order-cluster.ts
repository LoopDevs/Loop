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
import { registerAdminOrderClusterDrillsOpenApi } from './admin-order-cluster-drills.js';

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

  // The two `/api/admin/orders/{orderId}*` drills + the
  // `AdminOrderView` schema live in
  // `./admin-order-cluster-drills.ts`. Registered after the two
  // aggregate paths below so OpenAPI path-registration order is
  // preserved.

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

  // The two per-order drills live in
  // `./admin-order-cluster-drills.ts` along with the
  // `AdminOrderView` schema. `adminPayoutView` is threaded through
  // for the payout-by-order path so the registered component stays
  // shared with the payouts cluster.
  registerAdminOrderClusterDrillsOpenApi(registry, errorResponse, AdminPayoutView);
}
