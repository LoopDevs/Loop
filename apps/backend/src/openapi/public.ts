/**
 * Public section of the OpenAPI spec — schemas + path
 * registrations for `/api/public/*` (the unauthenticated marketing
 * surface: landing-page aggregates, top-cashback merchants, per-
 * merchant SEO detail, cashback preview, LOOP-asset transparency).
 *
 * Fifth per-domain module of the openapi.ts decomposition (after
 * #1153 auth, #1154 merchants, #1155 orders, #1156 users).
 *
 * Shared dependencies passed in:
 * - `errorResponse` — registered ErrorResponse from openapi.ts
 *   shared components.
 *
 * Per ADR 020 the public surface is never-500 + Cache-Control
 * friendly + no-PII. Every path declaration here preserves the
 * per-status response wiring + every description verbatim so the
 * generated OpenAPI document stays content-identical.
 */
import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/**
 * Registers all `/api/public/*` schemas + paths on the supplied
 * registry. Called once from openapi.ts during module init.
 */
export function registerPublicOpenApi(
  registry: OpenAPIRegistry,
  errorResponse: ReturnType<OpenAPIRegistry['register']>,
): void {
  // ─── Public — landing-page aggregates (ADR 009 / 015 / 020) ────────────────

  const PerCurrencyCashback = registry.register(
    'PerCurrencyCashback',
    z.object({
      currency: z.string().length(3),
      amountMinor: z.string().openapi({
        description: 'bigint-as-string. Minor units (pence / cents).',
      }),
    }),
  );

  const PublicCashbackStats = registry.register(
    'PublicCashbackStats',
    z.object({
      totalUsersWithCashback: z.number().int().min(0),
      totalCashbackByCurrency: z.array(PerCurrencyCashback),
      fulfilledOrders: z.number().int().min(0),
      asOf: z.string().datetime(),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/public/cashback-stats',
    summary: 'Fleet-wide cashback aggregates for the landing page.',
    description:
      'Unauthenticated, CDN-friendly. Returns the user count with any earned cashback, per-currency cashback totals, and fulfilled order count. `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path if the backend is serving a last-known-good snapshot or zeros. Never 500 — a DB outage degrades to stale/zero rather than propagating to unauthenticated visitors.',
    tags: ['Public'],
    responses: {
      200: {
        description: 'Cashback stats snapshot',
        content: { 'application/json': { schema: PublicCashbackStats } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  // ─── Public — top cashback merchants (ADR 011 / 020) ───────────────────────

  const TopCashbackMerchant = registry.register(
    'TopCashbackMerchant',
    z.object({
      id: z.string(),
      name: z.string(),
      logoUrl: z.string().nullable(),
      userCashbackPct: z.string().openapi({
        description: 'numeric(5,2) as string, e.g. "15.00".',
      }),
    }),
  );

  const PublicTopCashbackMerchantsResponse = registry.register(
    'PublicTopCashbackMerchantsResponse',
    z.object({
      merchants: z.array(TopCashbackMerchant),
      asOf: z.string().datetime(),
    }),
  );

  const PublicLoopAsset = registry.register(
    'PublicLoopAsset',
    z.object({
      code: z.enum(['USDLOOP', 'GBPLOOP', 'EURLOOP']).openapi({
        description: 'LOOP-branded fiat stablecoin code (ADR 015).',
      }),
      issuer: z.string().openapi({
        description: 'Stellar G-account that mints the asset. Pinned by env at boot.',
      }),
    }),
  );

  const PublicLoopAssetsResponse = registry.register(
    'PublicLoopAssetsResponse',
    z.object({ assets: z.array(PublicLoopAsset) }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/public/loop-assets',
    summary: 'Configured LOOP-asset (code, issuer) pairs (ADR 015 / 020).',
    description:
      'Public transparency surface. Lists the LOOP-branded Stellar assets Loop pays cashback in, with their issuer public keys, so third-party wallets + users adding trustlines can verify the asset list without guessing from on-chain traffic. Only issuer-configured pairs appear — publishing an unconfigured code would risk users opening a trustline to a spoofed issuer. `Cache-Control: public, max-age=300` on the happy path, `max-age=60` on the empty-list fallback. Never 500.',
    tags: ['Public'],
    responses: {
      200: {
        description: 'Configured LOOP-asset pairs (possibly empty).',
        content: { 'application/json': { schema: PublicLoopAssetsResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  const PublicFlywheelStats = registry.register(
    'PublicFlywheelStats',
    z.object({
      windowDays: z.number().int().openapi({ description: 'Fixed 30-day window.' }),
      fulfilledOrders: z.number().int(),
      recycledOrders: z.number().int(),
      pctRecycled: z.string().openapi({
        description:
          'One-decimal percentage string, e.g. `"12.3"`. `"0.0"` when the denominator is zero.',
      }),
    }),
  );

  registry.registerPath({
    method: 'get',
    path: '/api/public/flywheel-stats',
    summary: 'Fleet-wide cashback-flywheel scalar (ADR 015 / 020).',
    description:
      'Unauthenticated marketing surface. Scalar `{ fulfilledOrders, recycledOrders, pctRecycled }` over the last 30 days — the complement to `/api/public/cashback-stats` (emission) showing the recycle side of the story. `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path. Never 500.',
    tags: ['Public'],
    responses: {
      200: {
        description: '30-day flywheel scalar.',
        content: { 'application/json': { schema: PublicFlywheelStats } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/public/top-cashback-merchants',
    summary: 'Top-N merchants by active cashback rate (ADR 011 / 020).',
    description:
      'Unauthenticated, CDN-friendly. Landing-page "best cashback" band. `?limit=` clamped 1..50 (default 10). Merchants whose row has been evicted from the in-memory catalog (ADR 021 Rule B) are dropped from the response so the list never links to about-to-vanish merchants. `Cache-Control: public, max-age=300` on the happy path; `max-age=60` on the fallback path. Never 500.',
    tags: ['Public'],
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Top merchants by user_cashback_pct, descending',
        content: { 'application/json': { schema: PublicTopCashbackMerchantsResponse } },
      },
      429: {
        description: 'Rate limit exceeded (60/min per IP)',
        content: { 'application/json': { schema: errorResponse } },
      },
    },
  });

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
