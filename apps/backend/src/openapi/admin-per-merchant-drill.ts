/**
 * Admin per-merchant drill OpenAPI registrations
 * (ADR 011 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin.ts` to keep that
 * file under the soft cap. Combines the two sub-sections that
 * back the `/admin/merchants/:id` drill page — the scalar batch
 * (flywheel-stats / cashback-summary / payment-method-share) and
 * the time-series companions (cashback-monthly / flywheel-activity
 * / top-earners). Both halves travel together because they share
 * the same merchantId path parameter and the same drill page.
 *
 * Carries 11 locally-scoped schemas with the slice:
 *
 *   - `AdminMerchantFlywheelStats`
 *   - `AdminMerchantCashbackCurrencyBucket`
 *   - `AdminMerchantCashbackSummary`
 *   - `MerchantPaymentMethodShareResponse` (+ inline
 *     `PaymentMethodBucketShape` constant)
 *   - `AdminMerchantCashbackMonthlyEntry`
 *   - `AdminMerchantCashbackMonthlyResponse`
 *   - `MerchantFlywheelActivityDay`
 *   - `MerchantFlywheelActivityResponse`
 *   - `MerchantTopEarnerRow`
 *   - `MerchantTopEarnersResponse`
 *
 * None of those names are referenced anywhere else in admin.ts —
 * they are all per-merchant-drill internal. Only `errorResponse`
 * crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the per-merchant drill (scalars + time-series) paths
 * + their locally-scoped schemas on the supplied registry. Called
 * once from `registerAdminOpenApi`.
 */
export function registerAdminPerMerchantDrillOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Admin per-merchant drill metrics (ADR 011/015/022) ────────────────────
  //
  // Scalar-per-merchant trio that backs the /admin/merchants/:id drill-down.
  // See ADR-022 for the triplet pattern — these are the per-merchant axis of
  // the fleet + per-merchant + per-user + self quartet shipped around the
  // cashback-flywheel pivot.

  const AdminMerchantFlywheelStats = registry.register(
    'AdminMerchantFlywheelStats',
    z.object({
      merchantId: z.string(),
      since: z.string().datetime().openapi({ description: 'Window start — 31 days ago.' }),
      totalFulfilledCount: z.number().int(),
      recycledOrderCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) over loop_asset orders. bigint-as-string.',
      }),
      totalChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) over every fulfilled order. bigint-as-string.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/flywheel-stats',
    summary: 'Per-merchant recycled-vs-total scalar (ADR 011 / 015).',
    description:
      'Drives the flywheel chip on the merchant drill. 31-day fixed window, home-currency-agnostic at the merchant axis. Zero-volume merchants return zeroed fields (not 404) — a catalog merchant with no orders yet is a valid row.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Per-merchant flywheel scalar',
        content: { 'application/json': { schema: AdminMerchantFlywheelStats } },
      },
      400: {
        description: 'Malformed merchantId',
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

  const AdminMerchantCashbackCurrencyBucket = registry.register(
    'AdminMerchantCashbackCurrencyBucket',
    z.object({
      currency: z.string().length(3),
      fulfilledCount: z.number().int(),
      lifetimeCashbackMinor: z.string().openapi({
        description:
          'SUM(user_cashback_minor) over fulfilled orders in this currency. bigint-as-string.',
      }),
      lifetimeChargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) in this currency — context for "cashback as % of spend".',
      }),
    }),
  );

  const AdminMerchantCashbackSummary = registry.register(
    'AdminMerchantCashbackSummary',
    z.object({
      merchantId: z.string(),
      totalFulfilledCount: z.number().int(),
      currencies: z.array(AdminMerchantCashbackCurrencyBucket).openapi({
        description:
          'One entry per charge currency the merchant has seen. Sorted desc by fulfilledCount. Multi-row because per-merchant volume spans user home_currencies (no coherent rolled-up denomination).',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/cashback-summary',
    summary: 'Per-currency lifetime cashback paid out on a merchant (ADR 009 / 011 / 015).',
    description:
      'Sourced from orders.user_cashback_minor (pinned at creation) rather than credit_transactions, so the number is stable even when a ledger row is delayed. Only state=fulfilled counts. Zero-volume merchants return empty currencies[], not 404.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Per-currency cashback summary for the merchant',
        content: { 'application/json': { schema: AdminMerchantCashbackSummary } },
      },
      400: {
        description: 'Malformed merchantId',
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

  // ─── Admin per-merchant time-series (ADR 011/015/022) ──────────────────────
  //
  // Second backfill batch (see #668 for the scalar batch). Time-series
  // companions to the per-merchant scalars — same drill page, same
  // merchantId path parameter, but with arrays keyed on day/month/user.

  const AdminMerchantCashbackMonthlyEntry = registry.register(
    'AdminMerchantCashbackMonthlyEntry',
    z.object({
      month: z.string().openapi({ description: '"YYYY-MM" in UTC.' }),
      currency: z.string().length(3),
      cashbackMinor: z.string().openapi({ description: 'bigint-as-string, minor units.' }),
    }),
  );

  const AdminMerchantCashbackMonthlyResponse = registry.register(
    'AdminMerchantCashbackMonthlyResponse',
    z.object({
      merchantId: z.string(),
      entries: z.array(AdminMerchantCashbackMonthlyEntry),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/cashback-monthly',
    summary: 'Per-merchant 12-month cashback emission trend (ADR 009/011/015).',
    description:
      'Scalar cashback-paid-out (see /cashback-summary) answers "how much total?"; this time-series answers "is it growing?". 12-month fixed window bucketed on fulfilled_at, sourced from orders.user_cashback_minor. Zero-volume merchants return empty entries[] (not 404).',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Per-(month, currency) cashback minted at the merchant',
        content: { 'application/json': { schema: AdminMerchantCashbackMonthlyResponse } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const MerchantFlywheelActivityDay = registry.register(
    'MerchantFlywheelActivityDay',
    z.object({
      day: z.string().openapi({ description: 'YYYY-MM-DD (UTC).' }),
      recycledCount: z.number().int(),
      totalCount: z.number().int(),
      recycledChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
      totalChargeMinor: z.string().openapi({ description: 'bigint-as-string.' }),
    }),
  );

  const MerchantFlywheelActivityResponse = registry.register(
    'MerchantFlywheelActivityResponse',
    z.object({
      merchantId: z.string(),
      days: z.number().int().openapi({ description: 'Window size — default 30, max 180.' }),
      rows: z.array(MerchantFlywheelActivityDay),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/flywheel-activity',
    summary: 'Per-merchant daily flywheel trajectory (ADR 011/015).',
    description:
      'Time-axis companion to /flywheel-stats — scalar answers "what is the share?", this answers "is it trending up?". generate_series LEFT JOIN zero-fills every day. Bucketed on fulfilled_at::date. Only state=fulfilled counts.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(180).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily recycled-vs-total series for the merchant',
        content: { 'application/json': { schema: MerchantFlywheelActivityResponse } },
      },
      400: {
        description: 'Malformed merchantId',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
      500: { description: 'DB error', content: { 'application/json': { schema: errorResponse } } },
    },
  });

  const MerchantTopEarnerRow = registry.register(
    'MerchantTopEarnerRow',
    z.object({
      userId: z.string().uuid(),
      email: z.string(),
      currency: z.string().length(3),
      orderCount: z.number().int(),
      cashbackMinor: z.string().openapi({
        description: 'SUM(user_cashback_minor) for this (user, currency). bigint-as-string.',
      }),
      chargeMinor: z.string().openapi({
        description: 'SUM(charge_minor) — context for "cashback as % of their spend".',
      }),
    }),
  );

  const MerchantTopEarnersResponse = registry.register(
    'MerchantTopEarnersResponse',
    z.object({
      merchantId: z.string(),
      since: z.string().datetime(),
      rows: z.array(MerchantTopEarnerRow),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/admin/merchants/{merchantId}/top-earners',
    summary: 'Top cashback earners at a merchant (ADR 009/011/015).',
    description:
      'Inverse axis of /api/admin/users/:userId/cashback-by-merchant — answers "who earns at Amazon?" rather than "where does Alice earn?". BD outreach surface. Joins users for email enrichment (admin-gated, PII exposure fine). Multi-currency: one user can appear twice if they have fulfilled orders at the merchant in two charge currencies.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ merchantId: z.string() }),
      query: z.object({
        days: z.coerce.number().int().min(1).max(366).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Ranked list of users by cashback earned at the merchant',
        content: { 'application/json': { schema: MerchantTopEarnersResponse } },
      },
      400: {
        description: 'Malformed merchantId',
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
