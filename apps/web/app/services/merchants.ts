import type {
  MerchantCashbackRateResponse,
  MerchantDetailResponse,
  MerchantListParams,
  MerchantListResponse,
  MerchantAllResponse,
  MerchantsCashbackRatesResponse,
} from '@loop/shared';
import { apiRequest, authenticatedRequest } from './api-client';

/** Fetches a paginated merchant list. */
export async function fetchMerchants(
  params: MerchantListParams = {},
): Promise<MerchantListResponse> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.q) qs.set('q', params.q);

  const query = qs.toString();
  return apiRequest<MerchantListResponse>(`/api/merchants${query ? `?${query}` : ''}`);
}

/**
 * Fetches the full merchant catalog in a single request (audit A-002).
 * Use this for UI surfaces that need every merchant — home directory,
 * map name lookup, navbar search — where pagination would silently
 * truncate the catalog.
 */
export async function fetchAllMerchants(): Promise<MerchantAllResponse> {
  return apiRequest<MerchantAllResponse>('/api/merchants/all');
}

/**
 * Fetches a single merchant by id, enriched with upstream CTX
 * long-form content (longDescription / terms / instructions) via the
 * authenticated backend handler. Requires a valid session — returns
 * 401 otherwise. Unauthenticated callers can use `fetchMerchantBySlug`
 * for the cached basics.
 */
export async function fetchMerchant(id: string): Promise<MerchantDetailResponse> {
  return authenticatedRequest<MerchantDetailResponse>(`/api/merchants/${encodeURIComponent(id)}`);
}

/**
 * Fetches a single merchant by slug (URL-encoded name).
 * O(1) on the backend — preferred over fetching all merchants.
 * Slug matches the URL param in /gift-card/:name routes.
 */
export async function fetchMerchantBySlug(slug: string): Promise<MerchantDetailResponse> {
  return apiRequest<MerchantDetailResponse>(`/api/merchants/by-slug/${encodeURIComponent(slug)}`);
}

// MerchantCashbackRateResponse and MerchantsCashbackRatesResponse are now the
// single source of truth from @loop/shared (packages/shared/src/merchants.ts —
// ADR 019). Re-exported so existing import sites that read them from this
// module keep resolving.
export type { MerchantCashbackRateResponse, MerchantsCashbackRatesResponse };

/**
 * Cashback-rate preview for the gift-card detail page. Public — no
 * auth required. Returns `userCashbackPct: null` for merchants that
 * haven't been configured yet, letting the caller hide the badge.
 */
export async function fetchMerchantCashbackRate(id: string): Promise<MerchantCashbackRateResponse> {
  return apiRequest<MerchantCashbackRateResponse>(
    `/api/merchants/${encodeURIComponent(id)}/cashback-rate`,
  );
}

/**
 * Bulk cashback-rate map for catalog / list views (ADR 011 / 015).
 * One request covers every merchant with an active config, letting
 * card-grid surfaces render "X% cashback" badges without N+1-ing the
 * per-merchant endpoint. Public — no auth required.
 */
export async function fetchMerchantsCashbackRates(): Promise<MerchantsCashbackRatesResponse> {
  return apiRequest<MerchantsCashbackRatesResponse>('/api/merchants/cashback-rates');
}
