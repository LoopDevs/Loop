import type { CreateOrderRequest, CreateOrderResponse, Order, OrderListResponse } from '@loop/shared';
import { authenticatedRequest } from './api-client';

/** Creates a new gift card order. Requires authentication. */
export async function createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
  return authenticatedRequest<CreateOrderResponse>('/api/orders', {
    method: 'POST',
    body: request,
  });
}

/** Fetches the order history for the current user. */
export async function fetchOrders(page = 1): Promise<OrderListResponse> {
  return authenticatedRequest<OrderListResponse>(`/api/orders?page=${page}`);
}

/** Fetches a single order by id. */
export async function fetchOrder(id: string): Promise<{ order: Order }> {
  return authenticatedRequest<{ order: Order }>(`/api/orders/${encodeURIComponent(id)}`);
}
