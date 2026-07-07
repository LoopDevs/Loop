import { describe, expect, it, vi } from 'vitest';
import type { HorizonPayment } from '../horizon.js';

vi.mock('../../env.js', () => ({
  env: {
    LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS: 10_000_000n,
    LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS: 1n,
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {},
  withAdvisoryLock: async <T>(_key: bigint, fn: () => Promise<T>) => ({
    ran: true as const,
    value: await fn(),
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
}));

vi.mock('../../discord.js', () => ({ notifyOperatorFloatDrift: vi.fn() }));
vi.mock('../../runtime-health.js', () => ({
  markWorkerStarted: vi.fn(),
  markWorkerStopped: vi.fn(),
  markWorkerTickFailure: vi.fn(),
  markWorkerTickSuccess: vi.fn(),
}));

import {
  classifyRun,
  computeExpectedBalance,
  extractOperatorMovement,
  thresholdForAsset,
} from '../operator-float-reconciliation.js';

const basePayment = (overrides: Partial<HorizonPayment> = {}): HorizonPayment => ({
  id: 'op-1',
  paging_token: 'pt-1',
  type: 'payment',
  from: 'GUSER',
  to: 'GOPERATOR',
  asset_type: 'native',
  amount: '1.5000000',
  transaction_hash: 'tx-1',
  transaction_successful: true,
  transaction: { memo_type: 'text', memo: 'memo-1', successful: true },
  ...overrides,
});

describe('operator float movement extraction', () => {
  it('extracts inbound native XLM movement involving the operator account', () => {
    const movement = extractOperatorMovement({
      payment: basePayment(),
      account: 'GOPERATOR',
      usdcIssuer: null,
    });

    expect(movement).toMatchObject({
      paymentId: 'op-1',
      asset: 'xlm',
      assetCode: 'XLM',
      direction: 'in',
      amountStroops: 15_000_000n,
      memoText: 'memo-1',
    });
  });

  it('extracts outbound configured USDC movement', () => {
    const movement = extractOperatorMovement({
      payment: basePayment({
        id: 'op-2',
        from: 'GOPERATOR',
        to: 'GCTX',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        amount: '12.3400000',
      }),
      account: 'GOPERATOR',
      usdcIssuer: 'GISSUER',
    });

    expect(movement).toMatchObject({
      paymentId: 'op-2',
      asset: 'usdc',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      direction: 'out',
      amountStroops: 123_400_000n,
    });
  });

  it('ignores non-configured USDC issuers and non-payment operations', () => {
    expect(
      extractOperatorMovement({
        payment: basePayment({
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GOTHER',
        }),
        account: 'GOPERATOR',
        usdcIssuer: 'GISSUER',
      }),
    ).toBeNull();

    expect(
      extractOperatorMovement({
        payment: basePayment({ type: 'create_account' }),
        account: 'GOPERATOR',
        usdcIssuer: null,
      }),
    ).toBeNull();
  });
});

describe('operator float reconciliation math', () => {
  it('adds opening balance, classified movement delta, and unlinked manual delta', () => {
    expect(
      computeExpectedBalance({
        openingBalanceStroops: 1000n,
        classifiedMovementDeltaStroops: -250n,
        unlinkedManualDeltaStroops: 75n,
      }),
    ).toBe(825n);
  });

  it('treats unclassified movement as degraded even when the balance delta is in band', () => {
    expect(classifyRun({ deltaStroops: 0n, thresholdStroops: 10n, unclassifiedCount: 1 })).toBe(
      'unclassified',
    );
  });

  it('uses threshold comparison for clean classified runs', () => {
    expect(classifyRun({ deltaStroops: 10n, thresholdStroops: 10n, unclassifiedCount: 0 })).toBe(
      'ok',
    );
    expect(classifyRun({ deltaStroops: -11n, thresholdStroops: 10n, unclassifiedCount: 0 })).toBe(
      'drift',
    );
  });

  it('uses fee-tolerant XLM and strict USDC defaults', () => {
    expect(thresholdForAsset('xlm')).toBe(10_000_000n);
    expect(thresholdForAsset('usdc')).toBe(1n);
  });
});
