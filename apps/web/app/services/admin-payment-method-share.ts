/**
 * A2-1165 (slice 13): admin payment-method-share trio extracted
 * from `services/admin.ts`. Three reads back the ADR 023 mix-axis
 * matrix for payment-rails (ADR 015):
 *
 * - `GET /api/admin/orders/payment-method-share` — fleet-wide.
 *   Cashback-flywheel metric: a rising `loop_asset` share is the
 *   signal that ADR 015's pivot is working.
 * - `GET /api/admin/merchants/:merchantId/payment-method-share` —
 *   merchant-scoped. Same `byMethod` shape, filtered via
 *   `WHERE merchant_id = :merchantId`.
 * - `GET /api/admin/users/:userId/payment-method-share` —
 *   user-scoped third sibling. Same shape + zero-filled buckets.
 *
 * All three default `?state=fulfilled` and accept any `OrderState`.
 * `byMethod` is keyed on `AdminPaymentMethod` and zero-filled by
 * the backend so the UI layout is stable across all four methods.
 *
 * The `PaymentMethodShareBucket` / `AdminPaymentMethod` /
 * `PaymentMethodShareResponse` /
 * `AdminMerchantPaymentMethodShareResponse` /
 * `AdminUserPaymentMethodShareResponse` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would just
 * add indirection. `services/admin.ts` keeps a barrel re-export so
 * existing consumers (`PaymentMethodShareCard.tsx`,
 * `MerchantPaymentMethodShareCard.tsx`,
 * `UserPaymentMethodShareCard.tsx`, paired tests) don't have to
 * re-target imports.
 */
import type { OrderState } from '@loop/shared';
import { authenticatedRequest } from './api-client';

/**
 * Payment-method share bucket. One entry per `ORDER_PAYMENT_METHODS`
 * value; backend zero-fills so the UI layout is stable.
 */
export interface PaymentMethodShareBucket {
  orderCount: number;
  /** Sum of charge_minor for this (state, method) bucket, bigint-as-string. */
  chargeMinor: string;
}

export type AdminPaymentMethod = 'xlm' | 'usdc' | 'credit' | 'loop_asset';

/**
 * Fleet-wide payment-method-share response. `state` defaults
 * server-side to `fulfilled`; callers pass any `OrderState` to
 * override.
 */
export interface PaymentMethodShareResponse {
  state: OrderState;
  totalOrders: number;
  byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>;
}

/** Merchant-scoped sibling — `byMethod` filtered by `merchant_id`. */
export interface AdminMerchantPaymentMethodShareResponse {
  merchantId: string;
  state: OrderState;
  totalOrders: number;
  byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>;
}

/** User-scoped third sibling — `byMethod` filtered by `user_id`. */
export interface AdminUserPaymentMethodShareResponse {
  userId: string;
  state: OrderState;
  totalOrders: number;
  byMethod: Record<AdminPaymentMethod, PaymentMethodShareBucket>;
}

/** `GET /api/admin/orders/payment-method-share` — default `?state=fulfilled`. */
export async function getPaymentMethodShare(
  opts: { state?: OrderState } = {},
): Promise<PaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<PaymentMethodShareResponse>(
    `/api/admin/orders/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/merchants/:merchantId/payment-method-share` — rail mix for one merchant. */
export async function getAdminMerchantPaymentMethodShare(
  merchantId: string,
  opts: { state?: OrderState } = {},
): Promise<AdminMerchantPaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<AdminMerchantPaymentMethodShareResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/users/:userId/payment-method-share` — rail mix for one user. */
export async function getAdminUserPaymentMethodShare(
  userId: string,
  opts: { state?: OrderState } = {},
): Promise<AdminUserPaymentMethodShareResponse> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set('state', opts.state);
  const qs = params.toString();
  return authenticatedRequest<AdminUserPaymentMethodShareResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/payment-method-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
