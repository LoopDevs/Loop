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
  opts: { limit?: number } = {},
): Promise<PublicTopCashbackMerchantsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
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
export async function getPublicMerchant(idOrSlug: string): Promise<PublicMerchantDetail> {
  return apiRequest<PublicMerchantDetail>(`/api/public/merchants/${encodeURIComponent(idOrSlug)}`);
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

/**
 * One configured LOOP asset from `/api/public/loop-assets` (#596).
 * `code` is the Stellar asset code; `issuer` is the G-account that
 * mints it. Both are public — the endpoint is an intentional
 * transparency surface so third-party wallets can add trustlines
 * against a verified issuer (ADR 015 anti-spoofing).
 *
 * The shape repeats what the backend exports locally rather than
 * pulling through `@loop/shared`. ADR 019 says to consolidate once
 * we have a second consumer; today the web side is the first.
 */
export interface PublicLoopAsset {
  code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP';
  issuer: string;
}

export interface PublicLoopAssetsResponse {
  assets: PublicLoopAsset[];
}

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
 * Public flywheel-stats response (#609). 30-day scalar of the
 * cashback-recycling signal — the forward-looking counterpart to
 * `PublicCashbackStats` (which only shows emission). Shape repeats
 * the backend export rather than pulling through `@loop/shared` —
 * ADR 019 consolidates when there's a second consumer; today the
 * web side is the first.
 */
export interface PublicFlywheelStats {
  windowDays: number;
  fulfilledOrders: number;
  recycledOrders: number;
  /** One-decimal percentage string, e.g. `"12.3"`. `"0.0"` when denom is zero. */
  pctRecycled: string;
}

/**
 * `GET /api/public/flywheel-stats` (ADR 015 / 020) — 30-day fleet-
 * wide flywheel scalar. Never-500: serves last-known-good snapshot
 * on DB trouble, zeros on bootstrap.
 */
export async function getPublicFlywheelStats(): Promise<PublicFlywheelStats> {
  return apiRequest<PublicFlywheelStats>('/api/public/flywheel-stats');
}
