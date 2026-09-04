/**
 * Loop-native order service (ADR 010 / ADR 052).
 *
 * Thin wrappers around `POST /api/orders/loop` and `GET /api/orders/loop/:id`.
 * The backend is BigInt-safe: integer columns come back as strings so we
 * don't lose precision here; the UI is responsible for parsing to
 * BigInt when it needs to do arithmetic.
 *
 * ADR 052: ctx is the payment processor. The create call relays CTX's
 * own payment instructions (`LoopOrderPaymentInstructions`) and the
 * order thereafter mirrors CTX's `displayStatus` — see the shared wire
 * contract in `@loop/shared/loop-orders.ts` (ADR 019). This module
 * re-exports under the historical web-side names so existing imports
 * (`CreateLoopOrderBody`, `LoopOrderView`, `LoopOrderState`) don't need
 * to fan out a rename across 10+ components and tests in the same PR.
 */
import type {
  CreateLoopOrderRequest,
  CreateLoopOrderResponse,
  LoopOrderListResponse,
  LoopOrderPaymentInstructions,
  LoopOrderView,
  OrderState,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type LoopOrderState = OrderState;
export type CreateLoopOrderBody = CreateLoopOrderRequest;
export type { CreateLoopOrderResponse, LoopOrderPaymentInstructions, LoopOrderView };

/**
 * A2-2003: stamps every `POST /api/orders/loop` with a fresh
 * `Idempotency-Key`. The backend dedups against (user_id, key) so a
 * double-clicked submit, a retried fetch, or a network-flap retransmit
 * all collapse onto a single order row + a single CTX card create.
 *
 * Generates a UUID v4 — 36 chars sits well inside the 16-128 server
 * window, the entropy is far past anything a client double-click can
 * collide on, and `crypto.randomUUID` is universally available in
 * supported browsers + the Capacitor webview.
 */
function freshOrderIdempotencyKey(): string {
  // `crypto.randomUUID()` requires a secure context; web runs over
  // HTTPS in prod and on `capacitor://` in the native shell which
  // counts as secure. Locally over `http://localhost` it's also OK.
  return crypto.randomUUID();
}

/**
 * POST /api/orders/loop — creates a Loop-native order in `unpaid` and
 * relays CTX's payment instructions for the chosen `cryptoCurrency`.
 *
 * Pass `idempotencyKey` if the caller has already minted one (e.g. the
 * payment-screen state survived a soft remount and we want to retry
 * without creating a duplicate). Otherwise the service mints a fresh
 * UUID v4 for each call so the natural double-click case is covered
 * without the caller thinking about it.
 */
export async function createLoopOrder(
  body: CreateLoopOrderBody,
  options: { idempotencyKey?: string } = {},
): Promise<CreateLoopOrderResponse> {
  return authenticatedRequest<CreateLoopOrderResponse>('/api/orders/loop', {
    method: 'POST',
    body,
    headers: {
      'Idempotency-Key': options.idempotencyKey ?? freshOrderIdempotencyKey(),
    },
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
    case 'unpaid':
      return 'Waiting for payment';
    case 'paid':
      return 'Payment received';
    case 'fulfilled':
      return 'Ready';
    case 'rejected':
      return 'Rejected';
    case 'refunded':
      return 'Refunded';
    case 'expired':
      return 'Expired';
  }
}

/** States where the UI should keep polling. */
export function isLoopOrderTerminal(state: LoopOrderState): boolean {
  return (
    state === 'fulfilled' || state === 'rejected' || state === 'refunded' || state === 'expired'
  );
}

/** Terminal-and-unhappy: the order will never fulfil. */
export function isLoopOrderFailure(state: LoopOrderState): boolean {
  return state === 'rejected' || state === 'refunded' || state === 'expired';
}
