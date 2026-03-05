import type { MerchantListResponse, MerchantDetailResponse, MerchantListParams } from '@loop/shared';
import { apiRequest } from './api-client';

/** Fetches a paginated merchant list. */
export async function fetchMerchants(params: MerchantListParams = {}): Promise<MerchantListResponse> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.q) qs.set('q', params.q);

  const query = qs.toString();
  return apiRequest<MerchantListResponse>(`/api/merchants${query ? `?${query}` : ''}`);
}

/** Fetches a single merchant by id. */
export async function fetchMerchant(id: string): Promise<MerchantDetailResponse> {
  return apiRequest<MerchantDetailResponse>(`/api/merchants/${encodeURIComponent(id)}`);
}

/**
 * Fetches a single merchant by slug (URL-encoded name).
 * O(1) on the backend — preferred over fetching all merchants.
 * Slug matches the URL param in /gift-card/:name routes.
 */
export async function fetchMerchantBySlug(slug: string): Promise<MerchantDetailResponse> {
  return apiRequest<MerchantDetailResponse>(`/api/merchants/by-slug/${encodeURIComponent(slug)}`);
}
