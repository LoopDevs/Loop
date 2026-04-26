/**
 * Merchants section of the OpenAPI spec — schemas + path
 * registrations for `/api/merchants/*` (the catalog surface
 * served from cached upstream data).
 *
 * Second per-domain module of the openapi.ts decomposition (after
 * #1153 auth). Same factory shape: `registerMerchantsOpenApi`
 * takes the registry + the shared schemas it needs and registers
 * its own zod definitions + path entries on the supplied
 * registry.
 *
 * Shared dependencies:
 * - `errorResponse` — the registered ErrorResponse from openapi.ts
 *   shared components.
 * - `cashbackPctString` — schema for `numeric(5,2)`-as-string
 *   percentages. Currently defined inline in openapi.ts (will
 *   move to a shared primitives module when admin extracts).
 *
 * The 6 endpoints + their per-status response wiring + every
 * description are preserved verbatim — generated spec is
 * byte-identical to before this slice.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers all `/api/merchants/*` schemas + paths on the
 * supplied registry. Called once from openapi.ts during module
 * init.
 */
export function registerMerchantsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
  cashbackPctString: z.ZodTypeAny,
  pagination: ReturnType<OpenAPIRegistry['register']>,
): void {
  const MerchantDenominations = registry.register(
    'MerchantDenominations',
    z.object({
      type: z.enum(['fixed', 'min-max']),
      denominations: z.array(z.string()),
      currency: z.string(),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
  );

  const Merchant = registry.register(
    'Merchant',
    z.object({
      id: z.string(),
      name: z.string(),
      logoUrl: z.string().optional(),
      cardImageUrl: z.string().optional(),
      savingsPercentage: z.number().optional(),
      denominations: MerchantDenominations.optional(),
      description: z.string().optional(),
      instructions: z.string().optional(),
      terms: z.string().optional(),
      enabled: z.boolean(),
      locationCount: z.number().optional(),
    }),
  );

  const MerchantListResponse = registry.register(
    'MerchantListResponse',
    z.object({
      merchants: z.array(Merchant),
      pagination,
    }),
  );

  const MerchantDetailResponse = registry.register(
    'MerchantDetailResponse',
    z.object({ merchant: Merchant }),
  );

  const MerchantAllResponse = registry.register(
    'MerchantAllResponse',
    z.object({
      merchants: z.array(Merchant),
      total: z.number(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/merchants',
    summary: 'Paginated merchant list with optional name filter.',
    tags: ['Merchants'],
    request: {
      query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        q: z.string().max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Merchant page',
        content: { 'application/json': { schema: MerchantListResponse } },
      },
      429: {
        description: 'Rate limit exceeded (180/min per IP) — A2-650',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/merchants/all',
    summary:
      'Full merchant catalog in a single response. Serves UI surfaces that need every merchant (audit A-002).',
    tags: ['Merchants'],
    responses: {
      200: {
        description: 'Complete merchant catalog',
        content: { 'application/json': { schema: MerchantAllResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP) — A2-650',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/merchants/by-slug/{slug}',
    summary: 'Fetch a merchant by URL-safe slug.',
    tags: ['Merchants'],
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: {
        description: 'Merchant',
        content: { 'application/json': { schema: MerchantDetailResponse } },
      },
      404: {
        description: 'Not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP) — A2-650',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/merchants/{id}',
    summary: 'Fetch a merchant by id.',
    tags: ['Merchants'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Merchant',
        content: { 'application/json': { schema: MerchantDetailResponse } },
      },
      401: {
        description: 'Missing or invalid bearer',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Not found',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (120/min per IP) — A2-1008',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

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
