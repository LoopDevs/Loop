import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { pendingPayouts } from '../schema.js';

type PendingPayoutRow = typeof pendingPayouts.$inferSelect;
type PendingPayoutInsert = typeof pendingPayouts.$inferInsert;

/**
 * ADR-024 §2: `pending_payouts` now serves two payout flows:
 *
 *   - `kind='order_cashback'` → existing order-fulfilment cashback
 *     payouts; `order_id` is NOT NULL and references `orders`.
 *   - `kind='withdrawal'`     → admin-initiated cash-out of a user's
 *     cashback balance to Stellar; `order_id IS NULL`.
 *
 * These tests guard the Drizzle mirror of the SQL migration: any
 * drift between the migration CHECKs and the TypeScript types means
 * callers get a narrower or wider contract than Postgres actually
 * enforces. Runtime assertions read the actual column definitions off
 * the schema object (nullability / defaults), not literals the test
 * constructs itself.
 */
describe('pending_payouts schema (A2-901 / ADR-024 §2)', () => {
  it('orderId is nullable on the inferred row type', () => {
    expectTypeOf<PendingPayoutRow['orderId']>().toEqualTypeOf<string | null>();
  });

  it('orderId is nullable with no default (withdrawal rows leave it NULL)', () => {
    // Compile-time: Drizzle's $inferInsert treats nullable columns as
    // optional, so a withdrawal writer can omit orderId entirely.
    const withdrawalInsert: PendingPayoutInsert = {
      userId: '00000000-0000-0000-0000-000000000000',
      kind: 'withdrawal',
      assetCode: 'USDC',
      assetIssuer: 'GAAA',
      toAddress: 'GBBB',
      amountStroops: 1n,
      memoText: 'withdraw',
    };
    expectTypeOf(withdrawalInsert).toMatchTypeOf<PendingPayoutInsert>();
    // Runtime: the actual column definition must be nullable and
    // default-free — an omitted orderId lands as NULL, not a value.
    expect(pendingPayouts.orderId.notNull).toBe(false);
    expect(pendingPayouts.orderId.hasDefault).toBe(false);
  });

  it('kind has a default of "order_cashback" for backfill-safety', () => {
    // Compile-time: kind is optional on insert because of the default.
    const cashbackInsert: PendingPayoutInsert = {
      userId: '00000000-0000-0000-0000-000000000000',
      orderId: '00000000-0000-0000-0000-000000000001',
      assetCode: 'USDLOOP',
      assetIssuer: 'GCCC',
      toAddress: 'GDDD',
      amountStroops: 1n,
      memoText: 'cashback',
    };
    expectTypeOf(cashbackInsert).toMatchTypeOf<PendingPayoutInsert>();
    // Runtime: the column definition carries the NOT NULL + DEFAULT
    // the migration declares — an insert that omits kind still lands
    // a row labelled 'order_cashback'.
    expect(pendingPayouts.kind.notNull).toBe(true);
    expect(pendingPayouts.kind.hasDefault).toBe(true);
    expect(pendingPayouts.kind.default).toBe('order_cashback');
  });

  it('kind admits only the two known values', () => {
    // Compile-time: the $type<> narrowing on the column is exactly the
    // two-member union — no third kind can be inserted or selected.
    expectTypeOf<PendingPayoutRow['kind']>().toEqualTypeOf<'order_cashback' | 'withdrawal'>();
    // Runtime: the schema object declares the CHECK constraint that
    // pins the same invariant in Postgres.
    const checkNames = getTableConfig(pendingPayouts).checks.map((c) => c.name);
    expect(checkNames).toContain('pending_payouts_kind_known');
    expect(checkNames).toContain('pending_payouts_kind_shape');
  });

  it('compensatedAt is nullable on the row type and has no default', () => {
    expectTypeOf<PendingPayoutRow['compensatedAt']>().toEqualTypeOf<Date | null>();
    expect(pendingPayouts.compensatedAt.notNull).toBe(false);
    expect(pendingPayouts.compensatedAt.hasDefault).toBe(false);
  });
});
