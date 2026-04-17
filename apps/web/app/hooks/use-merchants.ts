import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type { Merchant, MerchantListResponse } from '@loop/shared';
import { fetchMerchants, fetchMerchant, fetchMerchantBySlug } from '~/services/merchants';

/**
 * Retry predicate: don't retry 4xx responses (client errors won't become 2xx
 * by trying again — 400 stays 400, 404 stays 404). Retry up to 2 times for
 * 5xx, timeouts, and network errors.
 */
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiException) {
    if (error.status >= 400 && error.status < 500) return false;
  }
  return failureCount < 2;
}

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
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: shouldRetry,
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
  // Trim upstream so whitespace-only slugs don't fire a guaranteed-404 request.
  const normalized = slug.trim();
  const query = useQuery<{ merchant: Merchant }, Error>({
    queryKey: ['merchant-by-slug', normalized],
    queryFn: () => fetchMerchantBySlug(normalized),
    staleTime: 5 * 60 * 1000,
    enabled: normalized.length > 0,
    refetchOnReconnect: true,
    retry: shouldRetry,
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
  const normalized = id.trim();
  const query = useQuery<{ merchant: Merchant }, Error>({
    queryKey: ['merchant', normalized],
    queryFn: () => fetchMerchant(normalized),
    staleTime: 5 * 60 * 1000,
    enabled: normalized.length > 0,
    refetchOnReconnect: true,
    retry: shouldRetry,
  });

  return {
    merchant: query.data?.merchant,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
