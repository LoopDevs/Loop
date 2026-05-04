import { useQuery } from '@tanstack/react-query';
import {
  listRecentlyPurchased,
  type RecentlyPurchasedMerchantView,
  type RecentlyPurchasedResponse,
} from '~/services/recently-purchased';
import { shouldRetry } from './query-retry';

export interface UseRecentlyPurchasedResult {
  /** Catalog-resolved merchants only — entries with `merchant: null` are filtered out. */
  merchants: RecentlyPurchasedMerchantView[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Reads the caller's recently-purchased merchants list. Gated on
 * `isAuthenticated` so we don't fire a guaranteed-401 request for
 * signed-out visitors.
 */
export function useRecentlyPurchased(isAuthenticated: boolean): UseRecentlyPurchasedResult {
  const query = useQuery<RecentlyPurchasedResponse, Error>({
    queryKey: ['user-recently-purchased'],
    queryFn: () => listRecentlyPurchased(),
    enabled: isAuthenticated,
    // 60s stale matches the favourites hook — both are read-mostly
    // home-page surfaces and the underlying ledger only changes on a
    // new order, which itself triggers query invalidation.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: shouldRetry,
  });

  return {
    merchants: (query.data?.merchants ?? []).filter((m) => m.merchant !== null),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
