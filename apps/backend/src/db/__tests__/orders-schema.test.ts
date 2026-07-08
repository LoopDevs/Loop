import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ORDER_STATES,
  ORDER_PAYMENT_METHODS,
  type OrderState,
  type OrderPaymentMethod,
  type orders,
} from '../schema.js';

type OrderRow = typeof orders.$inferSelect;
type OrderInsert = typeof orders.$inferInsert;

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
  it('covers xlm + usdc + credit + loop_asset (ADR 010 + ADR 015)', () => {
    expect(new Set(ORDER_PAYMENT_METHODS)).toEqual(
      new Set(['xlm', 'usdc', 'credit', 'loop_asset']),
    );
  });

  it('exposes a union type usable as OrderPaymentMethod', () => {
    const sample: OrderPaymentMethod = 'credit';
    expect(ORDER_PAYMENT_METHODS).toContain(sample);
  });

  it('loop_asset is a valid value (ADR 015 LOOP-branded payment)', () => {
    const sample: OrderPaymentMethod = 'loop_asset';
    expect(ORDER_PAYMENT_METHODS).toContain(sample);
  });
});

/**
 * Migration 0034 (redemption-backfill bookkeeping): the Drizzle
 * mirror must keep `redemption_backfill_attempts` NOT NULL DEFAULT 0
 * and `redemption_backfill_last_attempt_at` nullable, or the sweeper
 * (orders/redemption-backfill.ts) compiles against a contract
 * Postgres doesn't enforce.
 */
describe('orders redemption-backfill columns (migration 0034)', () => {
  it('attempts is a non-null number on the row type', () => {
    expectTypeOf<OrderRow['redemptionBackfillAttempts']>().toEqualTypeOf<number>();
  });

  it('last_attempt_at is nullable on the row type', () => {
    expectTypeOf<OrderRow['redemptionBackfillLastAttemptAt']>().toEqualTypeOf<Date | null>();
  });

  it('both columns are optional on insert (DEFAULT 0 / NULL)', () => {
    expectTypeOf<OrderInsert['redemptionBackfillAttempts']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<OrderInsert['redemptionBackfillLastAttemptAt']>().toEqualTypeOf<
      Date | null | undefined
    >();
  });
});

describe('orders paying-payment identity columns (migration 0050)', () => {
  it('payment_received_horizon_id is nullable on row and insert', () => {
    expectTypeOf<OrderRow['paymentReceivedHorizonId']>().toEqualTypeOf<string | null>();
    expectTypeOf<OrderInsert['paymentReceivedHorizonId']>().toEqualTypeOf<
      string | null | undefined
    >();
  });

  it('payment_received_tx_hash is nullable on row and insert', () => {
    expectTypeOf<OrderRow['paymentReceivedTxHash']>().toEqualTypeOf<string | null>();
    expectTypeOf<OrderInsert['paymentReceivedTxHash']>().toEqualTypeOf<string | null | undefined>();
  });

  it('payment_received_payment is nullable on row and insert', () => {
    expectTypeOf<OrderRow['paymentReceivedPayment']>().toEqualTypeOf<unknown>();
    expectTypeOf<OrderInsert['paymentReceivedPayment']>().toEqualTypeOf<unknown>();
  });
});
