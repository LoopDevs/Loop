/**
 * Loop order wire shapes (ADR 052).
 *
 * `POST /api/orders/loop` + `GET /api/orders/loop/:id` + `GET /api/orders/loop`.
 * These live in @loop/shared because both `apps/web` and `apps/backend`
 * need the exact same wire contract (A2-1504). Both sides import from
 * here.
 *
 * ctx is the payment processor: the create response relays CTX's own
 * payment instructions (address / payment URIs / crypto amount) and
 * the order thereafter mirrors CTX's `displayStatus`. Integer columns
 * serialise as strings (BigInt-safe). Timestamps are ISO-8601.
 */
import type { OrderState } from './order-state.js';

/**
 * Request body for `POST /api/orders/loop`.
 *
 * - `amountMinor` is the gift-card face value in the catalog currency's
 *   minor units. Accepted as either number or numeric string — the
 *   backend transforms both to `bigint`.
 * - `cryptoCurrency` is the chain-qualified CTX payment currency the
 *   customer chose (e.g. `XLM`, `DASH`, `ETH.USDT`), validated against
 *   the server's `LOOP_CTX_PAYMENT_CURRENCIES` allowlist.
 */
export interface CreateLoopOrderRequest {
  merchantId: string;
  amountMinor: number | string;
  /** ISO 4217 3-letter code. Backend uppercases. */
  currency: string;
  cryptoCurrency: string;
}

/**
 * CTX's payment instructions for an unpaid order, relayed verbatim
 * from the gift-card create / payment read. The customer pays CTX
 * directly — Loop never receives these funds.
 */
export interface LoopOrderPaymentInstructions {
  /** CTX payment row id backing the card. */
  ctxPaymentId: string | null;
  /** Chain-qualified currency the customer chose to pay in. */
  cryptoCurrency: string;
  /** Amount to send in the crypto currency's major units (decimal string). */
  cryptoAmount: string | null;
  /** Single deposit address, when CTX derived exactly one for the currency. */
  address: string | null;
  /**
   * Per-currency payment URIs from CTX (BIP70 `dash:?r=`, SEP-7
   * `web+stellar:pay?...`, `ethereum:`, `solana:`, ...). Keyed by
   * currency string; may be empty for address-only chains (DOGE, XRD).
   */
  paymentUrls: Record<string, string>;
  /** What the customer pays CTX (face value minus cashback discount). */
  amountMinor: string;
  currency: string;
  /** CTX payment-window expiry. Null when the payment read was unavailable. */
  expiresAt: string | null;
}

/** Response for `POST /api/orders/loop`. */
export interface CreateLoopOrderResponse {
  orderId: string;
  state: OrderState;
  payment: LoopOrderPaymentInstructions;
}

/**
 * Read-side view returned by `GET /api/orders/loop` + `GET /api/orders/loop/:id`.
 *
 * `faceValueMinor` / `currency` is what the gift card is worth in the
 * catalog currency; `chargeMinor` / `chargeCurrency` is what the
 * customer pays CTX (face minus the cashback discount). `payment` is
 * populated ONLY for a still-`unpaid` order on the detail read — the
 * pay screen is fully server-rebuildable from this response, never
 * from client-persisted storage.
 */
export interface LoopOrderView {
  id: string;
  merchantId: string;
  state: OrderState;
  faceValueMinor: string;
  currency: string;
  chargeMinor: string;
  chargeCurrency: string;
  /** Cashback CTX applied as a checkout discount (minor units of `currency`). */
  userCashbackMinor: string;
  ctxOrderId: string | null;
  /** Chain-qualified CTX payment currency chosen at create. Null on legacy rows. */
  paymentCryptoCurrency: string | null;
  /** CTX payment instructions; non-null only while `unpaid` on the detail read. */
  payment: LoopOrderPaymentInstructions | null;
  redeemCode: string | null;
  redeemPin: string | null;
  redeemUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  fulfilledAt: string | null;
  failedAt: string | null;
}

/** Response for `GET /api/orders/loop`. */
export interface LoopOrderListResponse {
  orders: LoopOrderView[];
}
