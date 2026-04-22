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
