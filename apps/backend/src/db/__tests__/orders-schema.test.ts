/**
 * Orders schema shape pins (ADR 052 mirror model). Type-level tests:
 * they compile-fail on drift rather than assert at runtime, plus a
 * few runtime pins on the shared enum.
 */
import { describe, it, expect } from 'vitest';
import { ORDER_STATES } from '../schema.js';
import type { OrderState, orders } from '../schema.js';

type OrderRow = typeof orders.$inferSelect;
type OrderInsert = typeof orders.$inferInsert;

describe('ORDER_STATES', () => {
  it('mirrors the CTX displayStatus lifecycle plus loop-local expired (ADR 052)', () => {
    expect(ORDER_STATES).toEqual([
      'unpaid',
      'paid',
      'fulfilled',
      'rejected',
      'refunded',
      'expired',
    ]);
  });

  it('exposes a union type usable as OrderState', () => {
    const s: OrderState = 'fulfilled';
    expect(ORDER_STATES).toContain(s);
  });
});

describe('orders redemption-backfill columns (migration 0034)', () => {
  it('attempts is a non-null number on the row type', () => {
    const v: OrderRow['redemptionBackfillAttempts'] = 0;
    expect(v).toBe(0);
  });

  it('last_attempt_at is nullable on the row type', () => {
    const v: OrderRow['redemptionBackfillLastAttemptAt'] = null;
    expect(v).toBeNull();
  });

  it('both columns are optional on insert (DEFAULT 0 / NULL)', () => {
    const insert: OrderInsert = {
      userId: 'u',
      merchantId: 'm',
      faceValueMinor: 1n,
      currency: 'USD',
      userCashbackMinor: 0n,
    };
    expect(insert.redemptionBackfillAttempts).toBeUndefined();
  });
});

describe('orders CTX mirror columns (migration 0076)', () => {
  it('ctx identifiers are nullable on row and insert', () => {
    const a: OrderRow['ctxOrderId'] = null;
    const b: OrderRow['ctxPaymentId'] = null;
    const c: OrderRow['paymentCryptoCurrency'] = null;
    const d: OrderInsert['ctxPaymentId'] = undefined;
    expect([a, b, c, d].every((v) => v === null || v === undefined)).toBe(true);
  });

  it('expected_commission_minor is a nullable bigint', () => {
    const v: OrderRow['expectedCommissionMinor'] = null;
    const w: OrderRow['expectedCommissionMinor'] = 123n;
    expect(v).toBeNull();
    expect(w).toBe(123n);
  });

  it('state defaults on insert (unpaid)', () => {
    const insert: OrderInsert = {
      userId: 'u',
      merchantId: 'm',
      faceValueMinor: 1n,
      currency: 'USD',
      userCashbackMinor: 0n,
    };
    expect(insert.state).toBeUndefined();
  });
});
