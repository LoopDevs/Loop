import type {
  MerchantListResponse,
  MerchantDetailResponse,
  MerchantListParams,
  MerchantAllResponse,
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
