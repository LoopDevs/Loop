import type { Order, OrderListResponse } from '@loop/shared';
import { authenticatedRequest } from './api-client';

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

/**
 * ADR 050: fetches the order's barcode image through the authed,
 * reference-keyed proxy (`GET /api/orders/:id/barcode-image`) — the
 * client never sees the upstream CTX URL. The endpoint always emits
 * JPEG, so the Blob's MIME type is static.
 */
export async function fetchOrderBarcodeImage(id: string): Promise<Blob> {
  const buffer = await authenticatedRequest<ArrayBuffer>(
    `/api/orders/${encodeURIComponent(id)}/barcode-image`,
    { binary: true },
  );
  return new Blob([buffer], { type: 'image/jpeg' });
}
