import { useQuery } from '@tanstack/react-query';
import type { Merchant, MerchantAllResponse, MerchantListResponse } from '@loop/shared';
import {
  fetchMerchants,
  fetchMerchant,
  fetchMerchantBySlug,
  fetchAllMerchants,
  fetchMerchantCashbackRate,
  fetchMerchantsCashbackRates,
  type MerchantCashbackRateResponse,
  type MerchantsCashbackRatesResponse,
} from '~/services/merchants';
import { shouldRetry } from './query-retry';

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

/**
 * Fetches the complete enabled merchant catalog via `/api/merchants/all`.
 * Use on surfaces that must see every merchant (home directory, map popup
 * name lookup, navbar search). The paginated `useMerchants` is capped at
 * 100 items per page by the backend (audit A-002), so it would silently
 * truncate a catalog larger than 100.
 */
export function useAllMerchants(): {
  merchants: Merchant[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const query = useQuery<MerchantAllResponse, Error>({
    queryKey: ['merchants-all'],
    queryFn: () => fetchAllMerchants(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: shouldRetry,
  });

  return {
    merchants: query.data?.merchants ?? [],
    total: query.data?.total ?? 0,
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

/**
 * Fetches a single merchant by id via the authenticated detail endpoint.
 * That endpoint proxies CTX's `/merchants/:id` (with the user's bearer
 * + X-Client-Id) to enrich the cached list record with long-form
 * content — longDescription / terms / instructions. Only fires when
 * `enabled` is true, i.e. when the caller has confirmed the user is
 * authed; otherwise it 401s unnecessarily.
 */
export function useMerchant(
  id: string,
  options: { enabled?: boolean } = {},
): {
  merchant: Merchant | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const normalized = id.trim();
  const enabled = (options.enabled ?? true) && normalized.length > 0;
  const query = useQuery<{ merchant: Merchant }, Error>({
    queryKey: ['merchant', normalized],
    queryFn: () => fetchMerchant(normalized),
    staleTime: 5 * 60 * 1000,
    enabled,
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

/**
 * Public cashback-rate preview for the gift-card detail page
 * (ADR 011 / 015). Returns `null` on:
 *  - missing id (query disabled),
 *  - the server replying with `userCashbackPct: null` (no active
 *    config for the merchant),
 *  - a network / server error — the badge is purely additive, so
 *    failing quietly is better than blocking the detail render.
 *
 * The response is cached 5 min on both the server (HTTP) and the
 * client (`staleTime`) since admin cashback edits are rare.
 */
export function useMerchantCashbackRate(id: string): { userCashbackPct: string | null } {
  const normalized = id.trim();
  const enabled = normalized.length > 0;
  const query = useQuery<MerchantCashbackRateResponse, Error>({
    queryKey: ['merchant-cashback-rate', normalized],
    queryFn: () => fetchMerchantCashbackRate(normalized),
    staleTime: 5 * 60 * 1000,
    enabled,
    retry: shouldRetry,
  });
  return { userCashbackPct: query.data?.userCashbackPct ?? null };
}

/**
 * Bulk cashback-rate map for catalog views (ADR 011 / 015). One
 * request covers every merchant with an active config; card-grid
 * components use the returned `lookup` fn to paint "X% cashback"
 * badges per row. Silent fallback — when the fetch is in-flight or
 * fails, every lookup returns `null` so the badges simply don't
 * render.
 */
export function useMerchantsCashbackRatesMap(): {
  lookup: (merchantId: string) => string | null;
} {
  const query = useQuery<MerchantsCashbackRatesResponse, Error>({
    queryKey: ['merchants-cashback-rates'],
    queryFn: fetchMerchantsCashbackRates,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetry,
  });
  const lookup = (merchantId: string): string | null => {
    return query.data?.rates[merchantId] ?? null;
  };
  return { lookup };
}
