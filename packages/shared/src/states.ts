/**
 * Order + payout + order-payment-method enums (ADR 009 / 010 / 015).
 *
 * Mirrors the CHECK constraints on `orders.state`, `orders.payment_method`,
 * and `pending_payouts.state` respectively. Shared between backend
 * (db schema, zod validators, handlers) and web (admin pages filter
 * chips, purchase-flow guards, test fixtures). One list per enum —
 * any change lands in schema.ts + a pair of admin pages in the same
 * commit rather than three separate places.
 */

export const ORDER_STATES = [
  'pending_payment',
  'paid',
  'procuring',
  'fulfilled',
  'failed',
  'expired',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** Narrow a raw string to an OrderState. */
export function isOrderState(value: string): value is OrderState {
  return (ORDER_STATES as ReadonlyArray<string>).includes(value);
}

export const ORDER_PAYMENT_METHODS = ['xlm', 'usdc', 'credit', 'loop_asset'] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export function isOrderPaymentMethod(value: string): value is OrderPaymentMethod {
  return (ORDER_PAYMENT_METHODS as ReadonlyArray<string>).includes(value);
}

export const PAYOUT_STATES = ['pending', 'submitted', 'confirmed', 'failed'] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

export function isPayoutState(value: string): value is PayoutState {
  return (PAYOUT_STATES as ReadonlyArray<string>).includes(value);
}
