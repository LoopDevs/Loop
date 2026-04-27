/**
 * Admin per-merchant time-axis drill OpenAPI registrations
 * (ADR 011 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/openapi/admin-per-merchant-drill.ts`
 * so the two trailing time-axis paths sit alongside their four
 * locally-scoped schemas, separate from the scalar / monthly
 * registrations in the parent file:
 *
 *   - GET /api/admin/merchants/{merchantId}/flywheel-activity
 *   - GET /api/admin/merchants/{merchantId}/top-earners
 *
 * `flywheel-activity` is the daily-trajectory companion to
 * `flywheel-stats` (parent file): the scalar answers "what is the
 * share?", this answers "is it trending up?". `top-earners` is the
 * per-merchant inverse axis of the per-user cashback-by-merchant
 * drill — "who earns at Amazon?" instead of "where does Alice earn?".
 *
 * Locally-scoped schemas (none referenced elsewhere in
 * admin-per-merchant-drill.ts — they travel with the slice):
 *   - `MerchantFlywheelActivityDay` / `MerchantFlywheelActivityResponse`
 *   - `MerchantTopEarnerRow` / `MerchantTopEarnersResponse`
 *
 * Re-invoked from `registerAdminPerMerchantDrillOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers the two per-merchant time-axis paths + their four
 * locally-scoped schemas on the supplied registry. Called once
 * from `registerAdminPerMerchantDrillOpenApi`.
 */
export function registerAdminPerMerchantTimeAxisOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
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
