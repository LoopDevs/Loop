import { useQuery } from '@tanstack/react-query';
import type { Merchant, MerchantListResponse } from '@loop/shared';
import { fetchMerchants, fetchMerchant, fetchMerchantBySlug } from '~/services/merchants';

export interface UseMerchantsOptions {
  page?: number;
  limit?: number;
  q?: string;
}

export interface UseMerchantsResult {
  merchants: Merchant[];
  totalPages: number;
  total: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

/** Fetches a paginated, optionally-filtered merchant list. */
export function useMerchants(options: UseMerchantsOptions = {}): UseMerchantsResult {
  const { page = 1, limit = 20, q } = options;

  const query = useQuery<MerchantListResponse, Error>({
    queryKey: ['merchants', { page, limit, q }],
    queryFn: () => fetchMerchants({ page, limit, ...(q !== undefined ? { q } : {}) }),
    staleTime: 5 * 60 * 1000,
  });

  return {
    merchants: query.data?.merchants ?? [],
    totalPages: query.data?.pagination.totalPages ?? 0,
    total: query.data?.pagination.total ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

/** Fetches a single merchant by URL slug (e.g. "amazon", "home-depot"). */
export function useMerchantBySlug(slug: string): {
  merchant: Merchant | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const query = useQuery<{ merchant: Merchant }, Error>({
    queryKey: ['merchant-by-slug', slug],
    queryFn: () => fetchMerchantBySlug(slug),
    staleTime: 5 * 60 * 1000,
    enabled: slug.length > 0,
  });

  return {
    merchant: query.data?.merchant,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

/** Fetches a single merchant by id. */
export function useMerchant(id: string): {
  merchant: Merchant | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const query = useQuery<{ merchant: Merchant }, Error>({
    queryKey: ['merchant', id],
    queryFn: () => fetchMerchant(id),
    staleTime: 5 * 60 * 1000,
    enabled: id.length > 0,
  });

  return {
    merchant: query.data?.merchant,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
