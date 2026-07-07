import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  OPERATOR_FLOAT_ASSETS,
  OPERATOR_FLOAT_CLASSIFICATIONS,
  OPERATOR_FLOAT_DIRECTIONS,
  OPERATOR_FLOAT_RUN_STATES,
  type OperatorFloatAsset,
  type OperatorFloatClassification,
  type OperatorFloatDirection,
  type OperatorFloatRunState,
  type operatorFloatReconciliationRuns,
  type operatorManualMovements,
  type operatorWalletBaselines,
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

  it('exposes bigint balances and nullable baseline/run fields with the expected row types', () => {
    expectTypeOf<BaselineRow['openingBalanceStroops']>().toEqualTypeOf<bigint>();
    expectTypeOf<BaselineRow['currentHorizonCursor']>().toEqualTypeOf<string | null>();
    expectTypeOf<ManualMovementRow['movementPaymentId']>().toEqualTypeOf<string | null>();
    expectTypeOf<MovementRow['classification']>().toEqualTypeOf<OperatorFloatClassification>();
    expectTypeOf<MovementRow['amountStroops']>().toEqualTypeOf<bigint>();
    expectTypeOf<RunRow['state']>().toEqualTypeOf<OperatorFloatRunState>();
    expectTypeOf<RunRow['deltaStroops']>().toEqualTypeOf<bigint | null>();
  });
});
