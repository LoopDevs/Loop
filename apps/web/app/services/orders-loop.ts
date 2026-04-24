/**
 * Loop-native order service (ADR 010).
 *
 * Thin wrappers around `POST /api/orders/loop` and `GET /api/orders/loop/:id`.
 * The backend is BigInt-safe: integer columns come back as strings so we
 * don't lose precision here; the UI is responsible for parsing to
 * BigInt when it needs to do arithmetic.
 *
 * A2-1504: wire contracts live in `@loop/shared` (ADR 019) — this
 * module re-exports under the historical web-side names so existing
 * imports (`CreateLoopOrderBody`, `LoopOrderView`, `LoopOrderState`,
 * `LoopOrderPaymentMethod`) don't need to fan out a rename across 10+
 * components and tests in the same PR.
 */
import type {
  CreateLoopOrderRequest,
  CreateLoopOrderResponse,
  LoopOrderListResponse,
  LoopOrderView,
  OrderState,
  OrderPaymentMethod,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type LoopOrderState = OrderState;
export type LoopOrderPaymentMethod = OrderPaymentMethod;
export type CreateLoopOrderBody = CreateLoopOrderRequest;
export type { CreateLoopOrderResponse, LoopOrderView };

/** POST /api/orders/loop — creates a Loop-native order in `pending_payment`. */
export async function createLoopOrder(body: CreateLoopOrderBody): Promise<CreateLoopOrderResponse> {
  return authenticatedRequest<CreateLoopOrderResponse>('/api/orders/loop', {
    method: 'POST',
    body,
  });
}

/** GET /api/orders/loop/:id — owner-scoped read of a Loop-native order. */
export async function getLoopOrder(id: string): Promise<LoopOrderView> {
  return authenticatedRequest<LoopOrderView>(`/api/orders/loop/${encodeURIComponent(id)}`);
}

/**
 * GET /api/orders/loop — owner-scoped list of the caller's Loop-native
 * orders, newest first. `limit` clamps 1–100 server-side (default 50).
 * Pagination: pass the last row's `createdAt` as `before` on the next
 * call.
 */
export async function listLoopOrders(
  args: { limit?: number; before?: string } = {},
): Promise<LoopOrderListResponse> {
  const params = new URLSearchParams();
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.before !== undefined) params.set('before', args.before);
  const qs = params.toString();
  return authenticatedRequest<LoopOrderListResponse>(
    `/api/orders/loop${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** Convenience: state labels for UI display. */
export function loopOrderStateLabel(state: LoopOrderState): string {
  switch (state) {
    case 'pending_payment':
      return 'Waiting for payment';
    case 'paid':
      return 'Payment received';
    case 'procuring':
      return 'Buying your gift card';
    case 'fulfilled':
      return 'Ready';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
  }
}

/** States where the UI should keep polling. */
export function isLoopOrderTerminal(state: LoopOrderState): boolean {
  return state === 'fulfilled' || state === 'failed' || state === 'expired';
}
