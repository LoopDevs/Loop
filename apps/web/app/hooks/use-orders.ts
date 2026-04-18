import { useQuery } from '@tanstack/react-query';
import type { Order, OrderListResponse } from '@loop/shared';
import { fetchOrders, fetchOrder } from '~/services/orders';
import { shouldRetry } from './query-retry';

export interface UseOrdersResult {
  orders: Order[];
  hasNext: boolean;
  hasPrev: boolean;
  total: number;
  totalPages: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  /** Force a refetch of the current page. Callers like a "Retry" button. */
  refetch: () => void;
}

/**
 * Fetches the authenticated user's order history.
 *
 * Gated on `isAuthenticated` so we don't fire `/api/orders` requests the
 * backend will 401. Under the covers TanStack Query cancels stale requests
 * when `page` changes, which removes the Prev/Next race the previous raw
 * useEffect-based implementation was vulnerable to (rapid clicks could
 * resolve in reverse order and show the wrong page's data).
 */
export function useOrders(page: number, isAuthenticated: boolean): UseOrdersResult {
  const query = useQuery<OrderListResponse, Error>({
    queryKey: ['orders', { page }],
    queryFn: () => fetchOrders(page),
    enabled: isAuthenticated,
    // Orders can change after user actions (new purchase, status update).
    // Fresh-on-focus makes the page feel live when the user returns from
    // paying in another tab.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: shouldRetry,
  });

  return {
    orders: query.data?.orders ?? [],
    hasNext: query.data?.pagination.hasNext ?? false,
    hasPrev: query.data?.pagination.hasPrev ?? false,
    total: query.data?.pagination.total ?? 0,
    totalPages: query.data?.pagination.totalPages ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** Fetches a single order by id. */
export function useOrder(
  id: string,
  isAuthenticated: boolean,
): {
  order: Order | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} {
  const normalized = id.trim();
  const query = useQuery<{ order: Order }, Error>({
    queryKey: ['order', normalized],
    queryFn: () => fetchOrder(normalized),
    enabled: isAuthenticated && normalized.length > 0,
    staleTime: 30 * 1000,
    refetchOnReconnect: true,
    retry: shouldRetry,
  });

  return {
    order: query.data?.order,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
