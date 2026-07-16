import type {
  CreateOrderRequest,
  CreateOrderResponse,
  Order,
  OrderListResponse,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

/** Creates a new gift card order. Requires authentication. */
export async function createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
  return authenticatedRequest<CreateOrderResponse>('/api/orders', {
    method: 'POST',
    body: request,
  });
}

/**
 * Fetches the order history for the current user.
 *
 * `excludePending=true` (AUD-08) asks the backend to server-paginate
 * over the NON-pending set. Before this, the list paginated over all
 * statuses and the client dropped `pending` rows locally — which could
 * render a false-empty page and hide Prev/Next, trapping the user away
 * from later completed orders. With server-side filtering each page is
 * stable and complete; the client-side `pending` drop in the route
 * remains only as defense-in-depth.
 */
export async function fetchOrders(page = 1): Promise<OrderListResponse> {
  return authenticatedRequest<OrderListResponse>(`/api/orders?page=${page}&excludePending=true`);
}

/** Fetches a single order by id. */
export async function fetchOrder(id: string): Promise<{ order: Order }> {
  return authenticatedRequest<{ order: Order }>(`/api/orders/${encodeURIComponent(id)}`);
}
