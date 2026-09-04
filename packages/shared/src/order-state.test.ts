import { describe, expect, it } from 'vitest';

import { ORDER_STATES, isOrderState } from './order-state.js';

describe('ORDER_STATES', () => {
  it('pins the ADR 052 mirror state machine exactly', () => {
    // Mirrors the `orders_state_known` CHECK in db/schema.ts — a change
    // here that isn't paired with a migration is an invariant violation.
    expect(ORDER_STATES).toEqual([
      'unpaid',
      'paid',
      'fulfilled',
      'rejected',
      'refunded',
      'expired',
    ]);
  });

  it('isOrderState narrows members and rejects non-members', () => {
    for (const s of ORDER_STATES) expect(isOrderState(s)).toBe(true);
    expect(isOrderState('')).toBe(false);
    expect(isOrderState('PAID')).toBe(false);
    expect(isOrderState('cancelled')).toBe(false);
    expect(isOrderState('pending_payment')).toBe(false);
  });
});
