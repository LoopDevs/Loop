import { describe, expect, expectTypeOf, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  OPERATOR_FLOAT_ASSETS,
  OPERATOR_FLOAT_CLASSIFICATIONS,
  OPERATOR_FLOAT_DIRECTIONS,
  OPERATOR_FLOAT_RUN_STATES,
  operatorWalletBaselines,
  type OperatorFloatAsset,
  type OperatorFloatClassification,
  type OperatorFloatDirection,
  type OperatorFloatRunState,
  type operatorFloatReconciliationRuns,
  type operatorManualMovements,
  type operatorWalletMovements,
} from '../schema.js';

type BaselineRow = typeof operatorWalletBaselines.$inferSelect;
type ManualMovementRow = typeof operatorManualMovements.$inferSelect;
type MovementRow = typeof operatorWalletMovements.$inferSelect;
type RunRow = typeof operatorFloatReconciliationRuns.$inferSelect;

describe('operator float schema mirrors', () => {
  it('pins the launch asset set to XLM + USDC', () => {
    expect(new Set(OPERATOR_FLOAT_ASSETS)).toEqual(new Set(['xlm', 'usdc']));
    const sample: OperatorFloatAsset = 'xlm';
    expect(OPERATOR_FLOAT_ASSETS).toContain(sample);
  });

  it('pins direction, classification, and run-state enums', () => {
    expect(new Set(OPERATOR_FLOAT_DIRECTIONS)).toEqual(new Set(['in', 'out']));
    expect(new Set(OPERATOR_FLOAT_CLASSIFICATIONS)).toEqual(
      new Set(['user_deposit', 'ctx_settlement', 'deposit_refund', 'manual', 'unclassified']),
    );
    expect(new Set(OPERATOR_FLOAT_RUN_STATES)).toEqual(
      new Set(['ok', 'drift', 'unclassified', 'needs_baseline', 'error']),
    );

    const direction: OperatorFloatDirection = 'out';
    const classification: OperatorFloatClassification = 'ctx_settlement';
    const state: OperatorFloatRunState = 'needs_baseline';
    expect(OPERATOR_FLOAT_DIRECTIONS).toContain(direction);
    expect(OPERATOR_FLOAT_CLASSIFICATIONS).toContain(classification);
    expect(OPERATOR_FLOAT_RUN_STATES).toContain(state);
  });

  it('pins one ACTIVE baseline per (account, asset) at the schema layer (migration 0054)', () => {
    const idx = getTableConfig(operatorWalletBaselines).indexes.find(
      (i) => i.config.name === 'operator_wallet_baselines_one_active',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it('pins cold-start cursor safety at the schema layer: both cursor columns NOT NULL + non-empty (migration 0057)', () => {
    expect(operatorWalletBaselines.startingHorizonCursor.notNull).toBe(true);
    expect(operatorWalletBaselines.currentHorizonCursor.notNull).toBe(true);
    const checkNames = getTableConfig(operatorWalletBaselines).checks.map((c) => c.name);
    expect(checkNames).toContain('operator_wallet_baselines_starting_cursor_len');
    expect(checkNames).toContain('operator_wallet_baselines_current_cursor_len');
  });

  it('exposes bigint balances and nullable baseline/run fields with the expected row types', () => {
    expectTypeOf<BaselineRow['openingBalanceStroops']>().toEqualTypeOf<bigint>();
    // Migration 0057 (production-readiness pass): both cursor columns
    // are DB-enforced NOT NULL — a nullable cursor let the reconciler
    // silently fall back to an unbounded full-history Horizon scan on
    // cold start (see the table docstring in `db/schema/reconciliation.ts`
    // and the `operator_wallet_baselines_starting_cursor_len` /
    // `_current_cursor_len` CHECK constraints).
    expectTypeOf<BaselineRow['startingHorizonCursor']>().toEqualTypeOf<string>();
    expectTypeOf<BaselineRow['currentHorizonCursor']>().toEqualTypeOf<string>();
    expectTypeOf<ManualMovementRow['movementPaymentId']>().toEqualTypeOf<string | null>();
    expectTypeOf<MovementRow['classification']>().toEqualTypeOf<OperatorFloatClassification>();
    expectTypeOf<MovementRow['amountStroops']>().toEqualTypeOf<bigint>();
    expectTypeOf<RunRow['state']>().toEqualTypeOf<OperatorFloatRunState>();
    expectTypeOf<RunRow['deltaStroops']>().toEqualTypeOf<bigint | null>();
  });
});
