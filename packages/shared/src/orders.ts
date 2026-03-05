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
