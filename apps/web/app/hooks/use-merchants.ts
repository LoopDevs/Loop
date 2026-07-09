import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  Merchant,
  MerchantAllResponse,
  MerchantListResponse,
  MerchantSearchResponse,
} from '@loop/shared';
import {
  fetchMerchants,
  fetchMerchant,
  fetchMerchantBySlug,
  fetchAllMerchants,
  fetchMerchantSearch,
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
    // PERF-003 (audit 2026-06-15-cold / CF-29): the merchant catalog
    // churns slowly (synced on a multi-hour cadence). Re-fetching the
    // list on every tab focus once staleTime lapses is wasted bandwidth
    // + main-thread JSON parse for no fresher data. staleTime governs
    // freshness; a focus-refetch buys nothing here.
    refetchOnWindowFocus: false,
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
    // PERF-003 (audit 2026-06-15-cold / CF-29): this is the full
    // ~1,134-record catalog (multi-hundred-KB JSON). Two cadence fixes:
    //  - longer `staleTime` (30 min) — the catalog syncs on a multi-hour
    //    cadence, and the `loop_merchants_all_v1` localStorage cache in
    //    root.tsx already covers cold-start render, so a 5-min stale
    //    window forced a redundant background refetch on routine
    //    navigation. 30 min still revalidates well within a session.
    //  - `refetchOnWindowFocus: false` — previously the whole payload
    //    re-downloaded on every tab focus once staleTime lapsed,
    //    including on routes that never render the catalog. staleTime +
    //    the localStorage cache cover freshness without the focus tax.
    queryFn: () => fetchAllMerchants(),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
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

export interface UseMerchantSearchOptions {
  /** ISO 3166-1 alpha-2 country code — ranks in-country matches first (ADR 034). */
  country?: string;
  /** Bounded result count passed to the server. Server default 20, max 50. */
  limit?: number;
  /**
   * Extra gate beyond the built-in "non-empty query" check — e.g. the
   * Navbar wants a length>1 floor before it fires (matching its
   * pre-existing client-filter behaviour). Defaults to `true`.
   */
  enabled?: boolean;
}

export interface UseMerchantSearchResult {
  merchants: Merchant[];
  /** True only on the very first fetch for a query with no cached data yet. */
  isLoading: boolean;
  /** True whenever a request is in flight, including a background refetch
   *  for a new query while the previous query's results are still shown
   *  (see `placeholderData: keepPreviousData` below). */
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
}

/**
 * Server-side merchant name search (go-live-plan §P3 / S4-7 §3 tail).
 * Replaces the client-side pattern of fetching the full catalog
 * (`useAllMerchants`) and filtering it on every keystroke — the Navbar
 * dropdown and MobileHome search both now call this instead.
 *
 * Callers debounce the raw input themselves (both already do, 150ms)
 * and pass the debounced value here so this doesn't fire a request on
 * every keystroke. `placeholderData: keepPreviousData` keeps the prior
 * result set on screen while a new debounced query is in flight,
 * instead of flashing to an empty state between keystrokes.
 */
export function useMerchantSearch(
  query: string,
  options: UseMerchantSearchOptions = {},
): UseMerchantSearchResult {
  const trimmed = query.trim();
  const enabled = (options.enabled ?? true) && trimmed.length > 0;
  const search = useQuery<MerchantSearchResponse, Error>({
    queryKey: ['merchant-search', trimmed, options.country ?? null, options.limit ?? null],
    queryFn: () =>
      fetchMerchantSearch({
        q: trimmed,
        ...(options.country !== undefined ? { country: options.country } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: shouldRetry,
  });

  return {
    merchants: search.data?.merchants ?? [],
    isLoading: search.isLoading,
    isFetching: search.isFetching,
    isError: search.isError,
    error: search.error,
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
