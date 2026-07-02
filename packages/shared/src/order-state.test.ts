import { describe, expect, it } from 'vitest';

import {
  ORDER_PAYMENT_METHODS,
  ORDER_STATES,
  isOrderPaymentMethod,
  isOrderState,
} from './order-state.js';

describe('ORDER_STATES', () => {
  it('pins the ADR 010 state machine exactly', () => {
    // Mirrors the `orders_state_known` CHECK in db/schema.ts — a change
    // here that isn't paired with a migration is an invariant violation.
    expect(ORDER_STATES).toEqual([
      'pending_payment',
      'paid',
      'procuring',
      'fulfilled',
      'failed',
      'expired',
    ]);
  });

  it('isOrderState narrows members and rejects non-members', () => {
    for (const s of ORDER_STATES) expect(isOrderState(s)).toBe(true);
    expect(isOrderState('')).toBe(false);
    expect(isOrderState('PAID')).toBe(false);
    expect(isOrderState('cancelled')).toBe(false);
  });
});

describe('ORDER_PAYMENT_METHODS', () => {
  it('pins the ADR 010/015 payment rails exactly', () => {
    expect(ORDER_PAYMENT_METHODS).toEqual(['xlm', 'usdc', 'credit', 'loop_asset']);
  });

  it('isOrderPaymentMethod narrows members and rejects non-members', () => {
    for (const m of ORDER_PAYMENT_METHODS) expect(isOrderPaymentMethod(m)).toBe(true);
    expect(isOrderPaymentMethod('XLM')).toBe(false);
    expect(isOrderPaymentMethod('sepa')).toBe(false);
  });
});
