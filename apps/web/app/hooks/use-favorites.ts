import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addFavorite,
  listFavorites,
  removeFavorite,
  type FavoriteMerchantView,
  type ListFavoritesResponse,
} from '~/services/favorites';
import { shouldRetry } from './query-retry';

export interface UseFavoritesResult {
  /** Favourites with a present catalog row, newest first. Evicted entries are filtered out. */
  favorites: FavoriteMerchantView[];
  /** Set of favourited merchant ids (incl. evicted) — use for "is this favourited?" checks. */
  favoritedIds: Set<string>;
  total: number;
  isLoading: boolean;
  isError: boolean;
}

const FAVORITES_QUERY_KEY = ['user-favorites'] as const;

/**
 * Reads the caller's favourites. Gated on `isAuthenticated` so we
 * don't fire a guaranteed-401 request for signed-out visitors.
 */
export function useFavorites(isAuthenticated: boolean): UseFavoritesResult {
  const query = useQuery<ListFavoritesResponse, Error>({
    queryKey: FAVORITES_QUERY_KEY,
    queryFn: listFavorites,
    enabled: isAuthenticated,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: shouldRetry,
  });

  const all = query.data?.favorites ?? [];
  return {
    // Hide evicted entries from the render path — the catalog is the
    // source of truth for what to show; the underlying favourite row
    // is preserved for restoration.
    favorites: all.filter((f) => f.merchant !== null),
    favoritedIds: new Set(all.map((f) => f.merchantId)),
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Toggle a merchant's favourite status. Optimistically updates the
 * cache so the heart icon flips immediately; rolls back on error.
 *
 * The UI calls `mutate({ merchantId, currentlyFavorited })` — the
 * `currentlyFavorited` flag picks add vs. remove without the caller
 * having to import two different hooks.
 */
export function useToggleFavorite(): {
  mutate: (args: { merchantId: string; currentlyFavorited: boolean }) => void;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (args: { merchantId: string; currentlyFavorited: boolean }) => {
      if (args.currentlyFavorited) {
        await removeFavorite(args.merchantId);
      } else {
        await addFavorite(args.merchantId);
      }
    },
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: FAVORITES_QUERY_KEY });
      const prev = queryClient.getQueryData<ListFavoritesResponse>(FAVORITES_QUERY_KEY);
      // We don't have the catalog row here, so optimistic-add inserts
      // a placeholder with `merchant: null`; the post-settle refetch
      // backfills the real data. The `useFavorites` hook filters
      // null-merchant entries from the rendered list anyway, so the
      // heart-icon state (driven by `favoritedIds`) flips immediately
      // while the grid waits for the refetch.
      queryClient.setQueryData<ListFavoritesResponse>(FAVORITES_QUERY_KEY, (current) => {
        if (current === undefined) return current;
        if (args.currentlyFavorited) {
          const next = current.favorites.filter((f) => f.merchantId !== args.merchantId);
          return { favorites: next, total: next.length };
        }
        const placeholder: FavoriteMerchantView = {
          merchantId: args.merchantId,
          createdAt: new Date().toISOString(),
          merchant: null,
        };
        const next = [placeholder, ...current.favorites];
        return { favorites: next, total: next.length };
      });
      return { prev };
    },
    onError: (_err, _args, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(FAVORITES_QUERY_KEY, context.prev);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY });
    },
  });

  return {
    mutate: (args) => mutation.mutate(args),
    isPending: mutation.isPending,
  };
}
