import type {
  PerCurrencyCashback,
  PublicCashbackStats,
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
