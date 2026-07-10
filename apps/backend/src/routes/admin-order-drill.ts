/**
 * `/api/admin/orders*` route mounts — the order-drill cluster
 * (ADR 010 / 011 / 015 / 019).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Six routes
 * that back the order-drill surfaces — same routes the openapi
 * spec splits into `./openapi/admin-order-cluster.ts` (#1177), plus
 * `POST /orders/:orderId/redrive` (A5-1, its own openapi slice
 * `./openapi/admin-order-redrive.ts`) and `POST /orders/:orderId/refund`
 * (A5-4, its own openapi slice `./openapi/admin-order-refund.ts`).
 *
 * Mount-order discipline preserved verbatim — the literal-suffix
 * routes (`/orders/activity`, `/orders/payment-method-share`,
 * `/orders/payment-method-activity`) MUST register BEFORE the
 * param-only `/orders/:orderId`, otherwise Hono\'s URL-template
 * tree captures the literal as a `:orderId` value. `/orders/:orderId/redrive`
 * and `/orders/:orderId/refund` are longer, distinctly-shaped templates
 * (3 segments vs 2) so neither collides with `/orders/:orderId`
 * regardless of registration order, but both are mounted after it for
 * readability (GETs before the writes).
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireStaff } from '../auth/require-staff.js';
import { requireAdminStepUp } from '../auth/admin-step-up-middleware.js';
import { adminGetOrderHandler } from '../admin/orders.js';
import { adminOrdersActivityHandler } from '../admin/orders-activity.js';
import { adminPaymentMethodShareHandler } from '../admin/payment-method-share.js';
import { adminPaymentMethodActivityHandler } from '../admin/payment-method-activity.js';
import { adminOrdersCsvHandler } from '../admin/orders-csv.js';
import { adminRedriveOrderHandler } from '../admin/order-redrive.js';
import { adminRefundOrderHandler } from '../admin/order-refund.js';

/**
 * Mounts the order-drill `/api/admin/orders/*` routes on the
 * supplied Hono app. Called once from `mountAdminRoutes` after
 * the admin middleware stack is in place.
 */
export function mountAdminOrderDrillRoutes(app: Hono): void {
  // 7-day (or N-day, clamped 1-90) order-activity sparkline. Drives the
  // admin dashboard's "created vs fulfilled per day" chart. Single
  // generate_series + LEFT JOIN; every day in the window appears with
  // zero-filled counts when no orders crossed. Registered before
  // `/:orderId` so the literal `/activity` matches first.
  app.get(
    '/api/admin/orders/activity',
    rateLimit('GET /api/admin/orders/activity', 60, 60_000),
    adminOrdersActivityHandler,
  );
  // Payment-method share aggregate — the cashback-flywheel metric.
  // Tracks the proportion of orders paid with each rail (xlm / usdc /
  // credit / loop_asset). ADR 010 / 015's strategy assumes a rising
  // loop_asset share once users have cashback to recycle; this is how
  // ops reads that. Registered before /:orderId so the literal
  // 'payment-method-share' doesn't get captured as an orderId.
  app.get(
    '/api/admin/orders/payment-method-share',
    rateLimit('GET /api/admin/orders/payment-method-share', 60, 60_000),
    adminPaymentMethodShareHandler,
  );
  // Time-series complement to /payment-method-share. Same four-rail
  // shape but bucketed per UTC day, capped at 90d, so the trend side
  // of the flywheel signal is observable — share is "where are we
  // now", activity is "where are we going". Registered before
  // /:orderId for the same literal-vs-param reason as its sibling.
  app.get(
    '/api/admin/orders/payment-method-activity',
    rateLimit('GET /api/admin/orders/payment-method-activity', 60, 60_000),
    adminPaymentMethodActivityHandler,
  );
  // Single-order drill-down (ADR 011 / 015). Permalink for an ops
  // ticket or incident note. Higher rate-limit than the list because
  // the admin UI re-fetches detail on every navigation.
  app.get(
    '/api/admin/orders/:orderId',
    rateLimit('GET /api/admin/orders/:orderId', 120, 60_000),
    adminGetOrderHandler,
  );
  // POST /api/admin/orders/:orderId/redrive — A5-1 order re-drive
  // lever. Re-runs the SAME procurement path the worker uses
  // (procureOne) for a stuck `paid` order (`procuring` is refused with
  // 409 — see the handler). Admin-tier +
  // step-up: unlike the ADR 037 support-tier delivery-unsticking
  // actions this can submit a real outbound Stellar payment to CTX.
  // 10/min: every call can be a CTX round-trip + up to ~5 minutes
  // waiting on the redemption stream, same tier reasoning as
  // refetch-redemption's CTX-round-trip limit.
  app.post(
    '/api/admin/orders/:orderId/redrive',
    rateLimit('POST /api/admin/orders/:orderId/redrive', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('order-redrive'),
    adminRedriveOrderHandler,
  );
  // POST /api/admin/orders/:orderId/refund — A5-4 order-bound refund.
  // Admin-tier + step-up (`order-refund` scope): reuses the SAME
  // primitives the existing auto-refund path uses per payment method
  // (on-chain refund-to-sender for xlm/usdc, mirror credit for
  // `credit`, fail-closed for `loop_asset` per R3-2); a `fulfilled`
  // order additionally requires a code-unused attestation in the body.
  // 10/min — matches redrive's cadence (can submit a real outbound
  // Stellar payment / touch Horizon for the ctxPaid disambiguation).
  app.post(
    '/api/admin/orders/:orderId/refund',
    rateLimit('POST /api/admin/orders/:orderId/refund', 10, 60_000),
    requireStaff('admin'),
    requireAdminStepUp('order-refund'),
    adminRefundOrderHandler,
  );
  // Finance-ready CSV export of Loop-native orders. Same rate-limit
  // cadence as other Tier-3 exports — ops runs it manually at month-end,
  // not on-click from the UI.
  app.get(
    '/api/admin/orders.csv',
    rateLimit('GET /api/admin/orders.csv', 10, 60_000),
    requireStaff('admin'),
    adminOrdersCsvHandler,
  );
}
