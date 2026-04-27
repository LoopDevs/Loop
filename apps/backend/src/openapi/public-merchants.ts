/**
 * Public per-merchant OpenAPI registrations
 * (ADR 011 / 015 / 020).
 *
 * Lifted out of `apps/backend/src/openapi/public.ts` so the two
 * merchant-facing public paths sit alongside their two
 * locally-scoped schemas, separate from the fleet-aggregate
 * paths in the parent file:
 *
 *   - GET /api/public/merchants/{id}      (SEO landing detail)
 *   - GET /api/public/cashback-preview    (pre-signup calculator)
 *
 * Both are unauthenticated reads that key off a merchant
 * id-or-slug, both follow the ADR-020 "never 500 — fall back to
 * soft-empty + short cache" convention, both 404 only on unknown
 * merchant. They power the conversion funnel: `/cashback/:slug`
 * landing page → calculator → signup.
 *
 * Locally-scoped schemas (none referenced elsewhere — they
 * travel with the slice):
 *   - `PublicMerchantDetail`
 *   - `PublicCashbackPreview`
 *
 * Re-invoked from `registerPublicOpenApi`.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers `/api/public/merchants/{id}` and
 * `/api/public/cashback-preview` plus their two locally-scoped
 * schemas on the supplied registry.
 */
export function registerPublicMerchantsOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  const PublicMerchantDetail = registry.register(
    'PublicMerchantDetail',
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string().openapi({
        description: 'Marketing slug — matches merchantSlug(name) on the web side.',
      }),
      logoUrl: z.string().nullable(),
      userCashbackPct: z.string().nullable().openapi({
        description:
          'numeric(5,2) as string, e.g. "5.50". null when no active config — the "coming soon" SEO state, distinct from "merchant not found" which returns 404.',
      }),
      asOf: z.string().datetime(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/public/merchants/{id}',
    summary: 'Per-merchant SEO detail (ADR 011 / 020).',
    description:
      'Unauthenticated single-merchant view for the /cashback/:slug landing page. Accepts merchant id OR slug as the path parameter. Narrow PII-free shape (no wholesale / margin — only user-facing cashback pct). Never 500: DB trouble → per-merchant last-known-good cache; first-miss → catalog row with null pct. 404 only for unknown id/slug (evicted merchants / typo URLs). `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path.',
    tags: ['Public'],
    request: {
      params: z.object({
        id: z.string().openapi({ description: 'Merchant id or slug.' }),
      }),
    },
    responses: {
      200: {
        description: 'Merchant catalog row + current cashback pct (or null)',
        content: { 'application/json': { schema: PublicMerchantDetail } },
      },
      400: {
        description: 'Malformed merchant id / slug',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Unknown merchant id / slug',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PublicCashbackPreview = registry.register(
    'PublicCashbackPreview',
    z.object({
      merchantId: z.string(),
      merchantName: z.string(),
      orderAmountMinor: z.string().openapi({
        description: 'Echo of the caller-supplied amountMinor, bigint-as-string.',
      }),
      cashbackPct: z.string().nullable().openapi({
        description: 'numeric(5,2) as string, null when no active config.',
      }),
      cashbackMinor: z.string().openapi({
        description: 'Computed cashback amount (floor). bigint-as-string. "0" when no config.',
      }),
      currency: z.string().length(3),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/public/cashback-preview',
    summary: 'Pre-signup "calculate your cashback" preview (ADR 011 / 015 / 020).',
    description:
      "Unauthenticated. Returns the cashback a would-be user would earn on an `amountMinor` order at `merchantId`. Matches the floor-rounded math used by `orders/cashback-split.ts` so the preview never promises more than the order-insert path will actually award. Missing config → 200 with `cashbackPct: null, cashbackMinor: '0'` (the 'coming soon' shape). Unknown merchant id/slug → 404. Never 500: a DB failure falls back to the soft-empty shape with `Cache-Control: max-age=60`.",
    tags: ['Public'],
    request: {
      query: z.object({
        merchantId: z.string().openapi({ description: 'Merchant id or slug.' }),
        amountMinor: z.string().openapi({
          description: 'Amount in merchant-currency minor units, as a non-negative integer string.',
        }),
      }),
    },
    responses: {
      200: {
        description: 'Cashback preview (may carry null pct for "coming soon")',
        content: { 'application/json': { schema: PublicCashbackPreview } },
      },
      400: {
        description: 'Malformed merchantId or amountMinor, or amount out of range',
        content: { 'application/json': { schema: errorResponse } },
      },
      404: {
        description: 'Unknown merchant id / slug',
        content: { 'application/json': { schema: errorResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });
}
