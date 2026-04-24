/**
 * Loop-native order wire shapes (ADR 010 / ADR 013 / ADR 015).
 *
 * `POST /api/orders/loop` + `GET /api/orders/loop/:id` + `GET /api/orders/loop`.
 * These live in @loop/shared because both `apps/web` and `apps/backend`
 * need the exact same wire contract — A2-1504 flagged the drift where
 * web's `LoopOrderView` was missing `chargeMinor`/`chargeCurrency` (the
 * ADR-015 home-currency split) and `CreateLoopOrderResponse` was missing
 * the `loop_asset` payment variant. Both sides now import from here.
 *
 * Integer columns serialise as strings (BigInt-safe). Timestamps are
 * ISO-8601.
 */
import type { OrderPaymentMethod, OrderState } from './order-state.js';
import type { LoopAssetCode } from './loop-asset.js';

/**
 * Request body for `POST /api/orders/loop`.
 *
 * - `amountMinor` is the gift-card face value in the catalog currency's
 *   minor units. Accepted as either number or numeric string — the
 *   backend transforms both to `bigint`.
 * - `paymentMethod` accepts the full `ORDER_PAYMENT_METHODS` union,
 *   including `loop_asset` (recycled LOOP-branded stablecoin, ADR 015).
 */
export interface CreateLoopOrderRequest {
  merchantId: string;
  amountMinor: number | string;
  /** ISO 4217 3-letter code. Backend uppercases. */
  currency: string;
  paymentMethod: OrderPaymentMethod;
}

/**
 * Response for `POST /api/orders/loop`.
 *
 * Discriminated union on `payment.method`:
 * - `xlm` / `usdc`: on-chain deposit. Client shows stellar address + memo.
 * - `loop_asset`: recycled LOOP-branded stablecoin. Same address + memo
 *   as `xlm`/`usdc`, plus `assetCode` + `assetIssuer` the client sends
 *   alongside the payment.
 * - `credit`: off-chain credit-ledger debit. No on-chain fields.
 */
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
        method: 'loop_asset';
        stellarAddress: string;
        memo: string;
        amountMinor: string;
        currency: string;
        assetCode: LoopAssetCode;
        assetIssuer: string;
      }
    | {
        method: 'credit';
        amountMinor: string;
        currency: string;
      };
}

/**
 * Read-side view returned by `GET /api/orders/loop` + `GET /api/orders/loop/:id`.
 *
 * `faceValueMinor` / `currency` is what the gift card is worth in the
 * catalog currency; `chargeMinor` / `chargeCurrency` is what the user
 * paid in their home currency. For pre-ADR-015 orders the two are
 * identical — clients that don't care about home-currency splits can
 * keep reading `faceValueMinor` + `currency`.
 */
export interface LoopOrderView {
  id: string;
  merchantId: string;
  state: OrderState;
  faceValueMinor: string;
  currency: string;
  chargeMinor: string;
  chargeCurrency: string;
  /**
   * The rail the user funded the order on. Includes `loop_asset`
   * (ADR 015 recycled-cashback path) so the UI can render the
   * "Recycled" badge — `LoopOrdersList.tsx` keys off this value.
   */
  paymentMethod: OrderPaymentMethod;
  paymentMemo: string | null;
  stellarAddress: string | null;
  userCashbackMinor: string;
  ctxOrderId: string | null;
  redeemCode: string | null;
  redeemPin: string | null;
  redeemUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
}

/** Response for `GET /api/orders/loop`. */
export interface LoopOrderListResponse {
  orders: LoopOrderView[];
}
