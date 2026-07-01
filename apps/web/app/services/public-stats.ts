import type {
  PerCurrencyCashback,
  PublicCashbackStats,
  PublicMerchantDetail,
  PublicTopCashbackMerchantsResponse,
  TopCashbackMerchant,
} from '@loop/shared';
import { apiRequest } from './api-client';

// Response shapes live in `@loop/shared` — one source of truth with
// the backend handler + openapi.ts schema (ADR 019 / 020). Re-exported
// so existing `import { PublicCashbackStats } from '~/services/public-stats'`
// callers keep resolving without every consumer learning the shared path.
export type {
  PerCurrencyCashback,
  PublicCashbackStats,
  PublicMerchantDetail,
  PublicTopCashbackMerchantsResponse,
  TopCashbackMerchant,
};

/**
 * `GET /api/public/cashback-stats` (ADR 020 Tier-1) — unauthenticated
 * marketing-facing aggregate. Never-500: backend serves a cached or
 * zero-valued snapshot when the DB is stale / unavailable.
 */
export async function getPublicCashbackStats(): Promise<PublicCashbackStats> {
  return apiRequest<PublicCashbackStats>('/api/public/cashback-stats');
}

/**
 * `GET /api/public/top-cashback-merchants` (ADR 020 Tier-1) — CDN-
 * friendly "best cashback" list for landing-page tiles. Server
 * clamps `?limit=` to 1..50 (default 10). Never-500: last-known-good
 * snapshot on DB trouble, empty list on bootstrap.
 */
export async function getPublicTopCashbackMerchants(
  opts: { limit?: number; country?: string } = {},
): Promise<PublicTopCashbackMerchantsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  // CAT-02 (2026-06-30 cold audit): scope the "best cashback" list to
  // the visitor's country, same rule home.tsx already uses.
  if (opts.country !== undefined) params.set('country', opts.country);
  const qs = params.toString();
  return apiRequest<PublicTopCashbackMerchantsResponse>(
    `/api/public/top-cashback-merchants${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/**
 * `GET /api/public/merchants/:id` (#647) — unauthenticated single-
 * merchant detail for the SEO landing page. Accepts id or slug.
 * Never-500 on DB trouble (last-known-good fallback). 404 for
 * unknown id/slug — callers should handle that as the
 * "merchant-not-in-catalog" page.
 */
export async function getPublicMerchant(
  idOrSlug: string,
  opts: { country?: string } = {},
): Promise<PublicMerchantDetail> {
  // CAT-02 (2026-06-30 cold audit): a merchant tagged to a different
  // country/currency than `opts.country` 404s server-side, same rule
  // home.tsx / brand.$slug.tsx already use.
  const qs = opts.country !== undefined ? `?country=${encodeURIComponent(opts.country)}` : '';
  return apiRequest<PublicMerchantDetail>(
    `/api/public/merchants/${encodeURIComponent(idOrSlug)}${qs}`,
  );
}

// A2-676 + ADR 019: PublicCashbackPreview was previously duplicated
// here + in the backend + in openapi. The single source of truth is
// now `@loop/shared`; re-export so existing `import` sites that read
// the type from `~/services/public-stats` keep resolving.
export type { PublicCashbackPreview } from '@loop/shared';
import type { PublicCashbackPreview } from '@loop/shared';

/**
 * `GET /api/public/cashback-preview?merchantId=<id>&amountMinor=<n>` —
 * pre-signup cashback calculator shape. Same floor-rounded math as
 * the order-insert path so the preview never over-promises.
 */
export async function getPublicCashbackPreview(args: {
  merchantId: string;
  amountMinor: number;
}): Promise<PublicCashbackPreview> {
  const qs = new URLSearchParams({
    merchantId: args.merchantId,
    amountMinor: String(args.amountMinor),
  }).toString();
  return apiRequest<PublicCashbackPreview>(`/api/public/cashback-preview?${qs}`);
}

// PublicLoopAsset, PublicLoopAssetsResponse, and PublicFlywheelStats are now
// the single source of truth from @loop/shared (ADR 019). Re-exported so
// existing import sites that read them from this module keep resolving.
export type { PublicFlywheelStats, PublicLoopAsset, PublicLoopAssetsResponse } from '@loop/shared';
import type { PublicFlywheelStats, PublicLoopAssetsResponse } from '@loop/shared';

/**
 * `GET /api/public/loop-assets` (ADR 015 / 020) — unauthenticated list
 * of configured LOOP stablecoin (code, issuer) pairs. Never-500;
 * empty list is a valid response for a deployment without issuers
 * configured. 5-minute Cache-Control on the happy path.
 */
export async function getPublicLoopAssets(): Promise<PublicLoopAssetsResponse> {
  return apiRequest<PublicLoopAssetsResponse>('/api/public/loop-assets');
}

/**
 * `GET /api/public/flywheel-stats` (ADR 015 / 020) — 30-day fleet-
 * wide flywheel scalar. Never-500: serves last-known-good snapshot
 * on DB trouble, zeros on bootstrap.
 */
export async function getPublicFlywheelStats(): Promise<PublicFlywheelStats> {
  return apiRequest<PublicFlywheelStats>('/api/public/flywheel-stats');
}
