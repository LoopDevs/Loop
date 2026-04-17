/** Status of a gift card order. */
export type OrderStatus = 'pending' | 'completed' | 'failed' | 'expired';

/** A placed gift card order. */
export interface Order {
  id: string;
  merchantId: string;
  merchantName: string;
  /** Fiat amount of the gift card (e.g. 10.00). */
  amount: number;
  currency: string;
  status: OrderStatus;
  /** XLM amount to pay / paid. */
  xlmAmount: string;
  /** Savings percentage for this order (e.g. "2.00"). */
  percentDiscount?: string;
  /** Redemption type: "url" (open URL + challenge) or "barcode" (code + pin). */
  redeemType?: 'url' | 'barcode';
  /** Gift card code — present when redeemType is "barcode" and status is "completed". */
  giftCardCode?: string;
  /** Gift card PIN — present for PIN-based cards. */
  giftCardPin?: string;
  /** Redemption URL — present when redeemType is "url" and status is "completed". */
  redeemUrl?: string;
  /** Challenge code for the redemption page. */
  redeemChallengeCode?: string;
  /** Optional scripts from CTX for automating redemption. */
  redeemScripts?: {
    injectChallenge?: string;
    scrapeResult?: string;
  };
  createdAt: string;
}

/**
 * Request body for POST /api/orders.
 *
 * Backend zod schema enforces the following — keep these in sync with
 * `CreateOrderBody` in apps/backend/src/orders/handler.ts:
 *   - merchantId: non-empty, max 128 chars
 *   - amount:     finite, 1 ≤ n ≤ 10_000, multipleOf 0.01 (2-decimal precision)
 */
export interface CreateOrderRequest {
  merchantId: string;
  /** Amount in the merchant's currency. Must be in [1, 10_000] with 2-decimal precision. */
  amount: number;
}

/** Response for POST /api/orders. */
export interface CreateOrderResponse {
  orderId: string;
  /** Stellar payment URI (web+stellar:pay?destination=...&amount=...&memo=...). */
  paymentUri: string;
  /** XLM payment address (extracted from URI). */
  paymentAddress: string;
  /** XLM amount to send. */
  xlmAmount: string;
  /** Payment memo (required for payment identification). */
  memo: string;
  /**
   * Unix timestamp (seconds) after which the payment window is closed.
   * Server-authoritative — use this directly rather than re-computing on the
   * client, which would drift relative to the server under clock skew.
   */
  expiresAt: number;
}

/** Paginated order history response. */
export interface OrderListResponse {
  orders: Order[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}
