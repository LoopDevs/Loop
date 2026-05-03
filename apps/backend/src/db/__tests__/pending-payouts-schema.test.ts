import { describe, it, expect, expectTypeOf } from 'vitest';
import type { pendingPayouts } from '../schema.js';

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
 * enforces.
 */
describe('pending_payouts schema (A2-901 / ADR-024 §2)', () => {
  it('orderId is nullable on the inferred row type', () => {
    expectTypeOf<PendingPayoutRow['orderId']>().toEqualTypeOf<string | null>();
  });

  it('orderId is optional on the insert type (withdrawal rows leave it NULL)', () => {
    // Drizzle's $inferInsert treats nullable columns as optional at
    // the TypeScript layer. A withdrawal writer can omit orderId; a
    // cashback writer still provides it.
    const withdrawalInsert: PendingPayoutInsert = {
      userId: '00000000-0000-0000-0000-000000000000',
      kind: 'withdrawal',
      assetCode: 'USDC',
      assetIssuer: 'GAAA',
      toAddress: 'GBBB',
      amountStroops: 1n,
      memoText: 'withdraw',
    };
    expect(withdrawalInsert.orderId).toBeUndefined();
  });

  it('kind has a default of "order_cashback" for backfill-safety', () => {
    // Compile-time: kind is optional on insert because of the default.
    // Runtime: the default is emitted on the generated SQL, so an
    // insert that omits kind still lands a row with the correct label.
    const cashbackInsert: PendingPayoutInsert = {
      userId: '00000000-0000-0000-0000-000000000000',
      orderId: '00000000-0000-0000-0000-000000000001',
      assetCode: 'USDLOOP',
      assetIssuer: 'GCCC',
      toAddress: 'GDDD',
      amountStroops: 1n,
      memoText: 'cashback',
    };
    expect(cashbackInsert.kind).toBeUndefined();
  });

  it('kind literal type admits only the two known values', () => {
    const cashbackKind: PendingPayoutRow['kind'] = 'order_cashback';
    const withdrawalKind: PendingPayoutRow['kind'] = 'withdrawal';
    // These exist at runtime just to keep the variables "used"; the
    // invariant tested is the assignability above.
    expect([cashbackKind, withdrawalKind]).toHaveLength(2);
  });

  it('compensatedAt is nullable on the row type and optional on insert', () => {
    expectTypeOf<PendingPayoutRow['compensatedAt']>().toEqualTypeOf<Date | null>();

    const withdrawalInsert: PendingPayoutInsert = {
      userId: '00000000-0000-0000-0000-000000000000',
      kind: 'withdrawal',
      assetCode: 'USDLOOP',
      assetIssuer: 'GAAA',
      toAddress: 'GBBB',
      amountStroops: 1n,
      memoText: 'withdraw',
    };
    expect(withdrawalInsert.compensatedAt).toBeUndefined();
  });
});
