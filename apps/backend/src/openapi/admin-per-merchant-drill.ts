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
 * Schemas registered directly here (cashback-flywheel scalars +
 * the cashback-monthly companion):
 *
 *   - `AdminMerchantFlywheelStats`
 *   - `AdminMerchantCashbackCurrencyBucket`
 *   - `AdminMerchantCashbackSummary`
 *   - `AdminMerchantCashbackMonthlyEntry`
 *   - `AdminMerchantCashbackMonthlyResponse`
 *
 * Sibling-owned schemas:
 *
 *   - `MerchantPaymentMethodShareResponse` (+ inline
 *     `PaymentMethodBucketShape`) →
 *     `./admin-per-merchant-payment-method-share.ts`
 *   - `MerchantFlywheelActivityDay/Response`,
 *     `MerchantTopEarnerRow/Response` →
 *     `./admin-per-merchant-drill-time-axis.ts`
 *
 * None of those names are referenced anywhere else in admin.ts —
 * they are all per-merchant-drill internal. Only `errorResponse`
 * crosses the slice boundary.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { registerAdminPerMerchantTimeAxisOpenApi } from './admin-per-merchant-drill-time-axis.js';
import { registerAdminPerMerchantPaymentMethodShareOpenApi } from './admin-per-merchant-payment-method-share.js';

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

  // ─── Admin per-merchant payment-method-share (ADR 010 / 015) ───────────────
  //
  // The merchant-scoped rail-mix path + its locally-scoped
  // `MerchantPaymentMethodShareResponse` (with the inline
  // `PaymentMethodBucketShape` constant) live in
  // `./admin-per-merchant-payment-method-share.ts`. Fanned out
  // here so the per-merchant drill registers as one factory call
  // from `admin.ts`.
  registerAdminPerMerchantPaymentMethodShareOpenApi(registry, errorResponse);

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

  // The two trailing time-axis paths
  // (`/merchants/{id}/flywheel-activity` and
  // `/merchants/{id}/top-earners`) plus their four locally-scoped
  // schemas (`MerchantFlywheelActivityDay`,
  // `MerchantFlywheelActivityResponse`, `MerchantTopEarnerRow`,
  // `MerchantTopEarnersResponse`) live in
  // `./admin-per-merchant-drill-time-axis.ts`. Same path-registration
  // position as the original block.
  registerAdminPerMerchantTimeAxisOpenApi(registry, errorResponse);
}
