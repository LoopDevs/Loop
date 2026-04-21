/**
 * Loop-native order service (ADR 010).
 *
 * Thin wrappers around `POST /api/orders/loop` and `GET /api/orders/loop/:id`.
 * The backend is BigInt-safe: integer columns come back as strings so we
 * don't lose precision here; the UI is responsible for parsing to
 * BigInt when it needs to do arithmetic.
 */
import { authenticatedRequest } from './api-client';

export type LoopOrderState =
  | 'pending_payment'
  | 'paid'
  | 'procuring'
  | 'fulfilled'
  | 'failed'
  | 'expired';

export type LoopOrderPaymentMethod = 'xlm' | 'usdc' | 'credit';

export interface CreateLoopOrderBody {
  merchantId: string;
  /** Face value in minor units (pence / cents). Passed as string to keep BigInts readable. */
  amountMinor: number | string;
  /** ISO 4217 3-letter code. */
  currency: string;
  paymentMethod: LoopOrderPaymentMethod;
}

export interface CreateLoopOrderResponse {
  orderId: string;
  payment:
    | {
        method: 'xlm' | 'usdc';
        stellarAddress: string;
        memo: string;
        amountMinor: string;
        currency: string;
      }
    | {
        method: 'credit';
        amountMinor: string;
        currency: string;
      };
}

/** POST /api/orders/loop — creates a Loop-native order in `pending_payment`. */
export async function createLoopOrder(body: CreateLoopOrderBody): Promise<CreateLoopOrderResponse> {
  return authenticatedRequest<CreateLoopOrderResponse>('/api/orders/loop', {
    method: 'POST',
    body,
  });
}

export interface LoopOrderView {
  id: string;
  merchantId: string;
  state: LoopOrderState;
  faceValueMinor: string;
  currency: string;
  paymentMethod: LoopOrderPaymentMethod;
  paymentMemo: string | null;
  stellarAddress: string | null;
  userCashbackMinor: string;
  ctxOrderId: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
}

/** GET /api/orders/loop/:id — owner-scoped read of a Loop-native order. */
export async function getLoopOrder(id: string): Promise<LoopOrderView> {
  return authenticatedRequest<LoopOrderView>(`/api/orders/loop/${encodeURIComponent(id)}`);
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
