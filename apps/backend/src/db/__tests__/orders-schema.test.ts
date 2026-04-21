import { describe, it, expect } from 'vitest';
import {
  ORDER_STATES,
  ORDER_PAYMENT_METHODS,
  type OrderState,
  type OrderPaymentMethod,
} from '../schema.js';

/**
 * The `orders` table's `state` column has a `CHECK` constraint listing
 * the allowed values; the `ORDER_STATES` const mirrors that list so
 * callers get a union type. These tests guard the mirror — if the
 * `CHECK` in the migration adds a state but `ORDER_STATES` doesn't,
 * TypeScript keeps thinking the state space is narrower than Postgres
 * actually accepts (or vice versa) and we write inconsistent code.
 *
 * Mirror is checked with a plain string-set comparison here; the SQL
 * side is guaranteed by the migration file `0002_loop_orders.sql`.
 */
describe('ORDER_STATES', () => {
  it('lists the full state machine from ADR 010', () => {
    expect(new Set(ORDER_STATES)).toEqual(
      new Set(['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']),
    );
  });

  it('exposes a union type usable as OrderState', () => {
    const sample: OrderState = 'paid';
    expect(ORDER_STATES).toContain(sample);
  });
});

describe('ORDER_PAYMENT_METHODS', () => {
  it('covers xlm + usdc + credit (ADR 010 launch set)', () => {
    expect(new Set(ORDER_PAYMENT_METHODS)).toEqual(new Set(['xlm', 'usdc', 'credit']));
  });

  it('exposes a union type usable as OrderPaymentMethod', () => {
    const sample: OrderPaymentMethod = 'credit';
    expect(ORDER_PAYMENT_METHODS).toContain(sample);
  });
});
