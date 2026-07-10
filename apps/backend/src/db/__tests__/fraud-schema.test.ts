/**
 * ADR 045 / migration 0059: the `fraud_signals` table plus the
 * `orders_payment_source_account` expression index. Pins the Drizzle
 * mirror of the hand-written SQL — check-migration-parity catches
 * catalog drift; these pin the TS-facing shape the catalog can't see
 * (CHECK constraint contents, index uniqueness/partiality).
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { fraudSignals, orders, FRAUD_SIGNAL_TYPES } from '../schema.js';

type FraudSignalRow = typeof fraudSignals.$inferSelect;
type FraudSignalInsert = typeof fraudSignals.$inferInsert;

describe('fraud_signals table (ADR 045 / migration 0059)', () => {
  it('signal_type is NOT NULL, no default', () => {
    expect(fraudSignals.signalType.notNull).toBe(true);
    expect(fraudSignals.signalType.hasDefault).toBe(false);
  });

  it('user_id is NOT NULL; related_user_id is nullable', () => {
    expect(fraudSignals.userId.notNull).toBe(true);
    expect(fraudSignals.relatedUserId.notNull).toBe(false);
    expectTypeOf<FraudSignalRow['relatedUserId']>().toEqualTypeOf<string | null>();
  });

  it('detail defaults to an empty object; created_at defaults to now', () => {
    expect(fraudSignals.detail.notNull).toBe(true);
    expect(fraudSignals.detail.hasDefault).toBe(true);
    expect(fraudSignals.createdAt.notNull).toBe(true);
    expect(fraudSignals.createdAt.hasDefault).toBe(true);
  });

  it('declares the signal_type CHECK mirror covering exactly the known types', () => {
    const checks = getTableConfig(fraudSignals).checks;
    const check = checks.find((c) => c.name === 'fraud_signals_type_known');
    expect(check).toBeDefined();
    // FRAUD_SIGNAL_TYPES is the single source of truth this CHECK
    // mirrors — Phase 1 ships exactly one detector.
    expect(FRAUD_SIGNAL_TYPES).toEqual(['shared_funding_source']);
  });

  it('declares the (signal_type, user_id, related_user_id) unique index', () => {
    const idx = getTableConfig(fraudSignals).indexes.find(
      (i) => i.config.name === 'fraud_signals_type_user_related_unique',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    // Not partial — every row (even a NULL related_user_id, which
    // Postgres treats as distinct-from-every-other-NULL) participates.
    expect(idx?.config.where).toBeUndefined();
  });

  it('declares the (user_id, created_at) browse index', () => {
    const idx = getTableConfig(fraudSignals).indexes.find(
      (i) => i.config.name === 'fraud_signals_user_created',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
  });

  it('declares the partial related_user_id index', () => {
    const idx = getTableConfig(fraudSignals).indexes.find(
      (i) => i.config.name === 'fraud_signals_related_user',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.where).toBeDefined();
  });

  it('declares both FKs to users', () => {
    const fks = getTableConfig(fraudSignals).foreignKeys;
    expect(fks).toHaveLength(2);
  });

  it('inserts require signalType + userId only (relatedUserId/detail optional)', () => {
    const insert: FraudSignalInsert = {
      signalType: 'shared_funding_source',
      userId: '11111111-1111-1111-1111-111111111111',
    };
    expectTypeOf(insert).toMatchTypeOf<FraudSignalInsert>();
  });
});

describe('orders_payment_source_account expression index (ADR 045 / migration 0059)', () => {
  it('orders declares the partial payment-source-account index', () => {
    const idx = getTableConfig(orders).indexes.find(
      (i) => i.config.name === 'orders_payment_source_account',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.where).toBeDefined();
  });
});
