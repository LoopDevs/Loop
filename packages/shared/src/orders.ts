/** Status of a gift card order. */
export type OrderStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'expired';

/** A placed gift card order. */
export interface Order {
  id: string;
  merchantId: string;
  merchantName: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  /** XLM amount paid. */
  xlmAmount?: string;
  /** Gift card code — only present when status is "completed". */
  giftCardCode?: string;
  /** Gift card PIN — only present for PIN-based cards. */
  giftCardPin?: string;
  /** Redemption URL — present instead of giftCardCode for URL-based redemption. */
  redeemUrl?: string;
  /** Challenge code to enter on the redemption page. */
  redeemChallengeCode?: string;
  /** Optional scripts from CTX for automating redemption. */
  redeemScripts?: {
    /** JS to auto-fill the challenge input on the provider page. Challenge value is pre-baked by CTX. */
    injectChallenge?: string;
    /** JS that observes the provider page and posts { type: 'loop:giftcard', code, pin } when gift card details appear. */
    scrapeResult?: string;
  };
  createdAt: number;
  completedAt?: number;
}

/** Request body for POST /api/orders. */
export interface CreateOrderRequest {
  merchantId: string;
  /** Amount in the merchant's currency (e.g. USD). */
  amount: number;
}

/** Response for POST /api/orders. */
export interface CreateOrderResponse {
  orderId: string;
  /** XLM payment address. */
  paymentAddress: string;
  /** XLM amount to send. */
  xlmAmount: string;
  /** Unix timestamp — payment window expires after this. */
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
