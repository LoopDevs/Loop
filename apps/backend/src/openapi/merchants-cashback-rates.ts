/**
 * Public merchant cashback-rate OpenAPI registrations
 * (ADR 011 / 015).
 *
 * Lifted out of `apps/backend/src/openapi/merchants.ts` so the
 * two cashback-rate read paths sit together separate from the
 * core merchant-catalog paths in the parent file:
 *
 *   - GET /api/merchants/cashback-rates           (bulk map)
 *   - GET /api/merchants/{merchantId}/cashback-rate (per-merchant)
 *
 * Both are public surfaces (no auth), both return
 * `numeric(5,2)`-as-string percentage values, both share the
 * 5-minute public cache and the 120/min per-IP rate limit. They
 * power the cashback-badge UX on the catalog list (bulk map) and
 * the gift-card detail page (per-merchant single value).
 *
 * `cashbackPctString` is registered upstream in openapi.ts (also
 * used by other sections); threaded into the new factory so every
 * consumer keeps the same registered component instance.
 *
 * Re-invoked from `registerMerchantsOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/merchants/cashback-rates` and
 * `/api/merchants/{merchantId}/cashback-rate` on the supplied
 * registry.
 */
export function registerMerchantsCashbackRatesOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  cashbackPctString: z.ZodTypeAny,
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/merchants/cashback-rates',
    summary: 'Bulk cashback-rate map for the merchant catalog (ADR 011 / 015).',
    description:
      'Returns a `{ merchantId → userCashbackPct }` map of every merchant with an active cashback config. Lets catalog / list / map views render "X% cashback" badges per card without N+1-ing the per-merchant endpoint. Merchants without an active config are omitted — clients should treat missing keys as "no cashback" and hide the badge. Values are `numeric(5,2)` strings (e.g. `"2.50"`). 5-minute public cache matches the merchant-catalog endpoints.',
    tags: ['Merchants'],
    responses: {
      200: {
        description: 'Bulk rates map',
        content: {
          'application/json': {
            schema: z.object({
              rates: z.record(z.string(), cashbackPctString).openapi({
                description:
                  'Object keyed by merchantId; present only for merchants with active configs.',
              }),
            }),
          },
        },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/merchants/{merchantId}/cashback-rate',
    summary: 'Cashback-rate preview for the gift-card detail page (ADR 011 / 015).',
    description:
      "Public surface — no auth. Returns the merchant's active `user_cashback_pct` as a bigint-shaped `numeric(5,2)` string, or `null` when the merchant has no cashback config (or it's inactive). Clients should hide the cashback badge on `null`. 5-minute public cache matches the merchant-catalog endpoints.",
    tags: ['Merchants'],
    request: { params: z.object({ merchantId: z.string() }) },
    responses: {
      200: {
        description: 'Cashback-rate preview',
        content: {
          'application/json': {
            schema: z.object({
              merchantId: z.string(),
              userCashbackPct: z
                .string()
                .regex(/^\d{1,3}(?:\.\d{1,2})?$/)
                .nullable()
                .openapi({
                  description:
                    'Percentage in [0, 100] with ≤2 decimals (e.g. `"2.50"`), or null when no active config exists.',
                }),
            }),
          },
        },
      },
      400: {
        description: 'Invalid merchant id (must match `[\\w-]+`).',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Merchant not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
