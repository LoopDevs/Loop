import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PayoutSubmitModule from '../../payments/payout-submit.js';

vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] ??= 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

// Mock the operator-pool resolver (returns null when unset, or
// a fully-shaped config when set). Each test sets `cfgState.current`.
const { cfgState, submitMock, findOutboundMock } = vi.hoisted(() => ({
  cfgState: {
    current: null as null | {
      operatorSecret: string;
      operatorAccount: string;
      horizonUrl: string;
      networkPassphrase: string;
      maxAttempts: number;
      intervalMs: number;
      watchdogStaleSeconds: number;
    },
  },
  submitMock: vi.fn(),
  findOutboundMock: vi.fn(),
}));

vi.mock('../../payments/payout-worker.js', () => ({
  resolvePayoutConfig: () => cfgState.current,
}));
vi.mock('../../payments/payout-submit.js', async () => {
  const actual = await vi.importActual<typeof PayoutSubmitModule>(
    '../../payments/payout-submit.js',
  );
  return {
    ...actual,
    submitNativePayment: (...args: unknown[]) => submitMock(...args),
  };
});
vi.mock('../../payments/horizon-find-outbound.js', () => ({
  findOutboundPaymentByMemo: (...args: unknown[]) => findOutboundMock(...args),
}));

import { payCtxOrder, PayCtxConfigError } from '../pay-ctx.js';
import { PayoutSubmitError } from '../../payments/payout-submit.js';

beforeEach(() => {
  submitMock.mockReset();
  findOutboundMock.mockReset();
  cfgState.current = {
    operatorSecret: 'SOP',
    operatorAccount: 'GOP',
    horizonUrl: 'https://horizon.test',
    networkPassphrase: 'Test Network',
    maxAttempts: 3,
    intervalMs: 1000,
    watchdogStaleSeconds: 60,
  };
});

describe('payCtxOrder', () => {
  it('submits a native XLM payment when no prior submit is on chain', async () => {
    findOutboundMock.mockResolvedValueOnce(null);
    submitMock.mockResolvedValueOnce({ txHash: 'new-tx', ledger: 1 });
    const r = await payCtxOrder({ destination: 'GCTX', amount: '0.1', memo: 'order-1' });
    expect(r).toEqual({ txHash: 'new-tx', submitted: true });
    expect(findOutboundMock).toHaveBeenCalledWith({
      account: 'GOP',
      to: 'GCTX',
      memo: 'order-1',
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
    const submitArgs = submitMock.mock.calls[0]![0] as { intent: Record<string, unknown> };
    expect(submitArgs.intent).toMatchObject({ to: 'GCTX', amount: '0.1', memoText: 'order-1' });
  });

  it('skips submit when Horizon already shows a matching outbound payment', async () => {
    findOutboundMock.mockResolvedValueOnce({ txHash: 'prior-tx', amount: '0.1', assetCode: null });
    const r = await payCtxOrder({ destination: 'GCTX', amount: '0.1', memo: 'order-1' });
    expect(r).toEqual({ txHash: 'prior-tx', submitted: false });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('throws PayCtxConfigError when LOOP_STELLAR_OPERATOR_SECRET is unset', async () => {
    cfgState.current = null;
    await expect(payCtxOrder({ destination: 'GCTX', amount: '0.1', memo: 'm' })).rejects.toThrow(
      PayCtxConfigError,
    );
  });

  it('propagates PayoutSubmitError from the submit step', async () => {
    findOutboundMock.mockResolvedValueOnce(null);
    submitMock.mockRejectedValueOnce(
      new PayoutSubmitError('terminal_underfunded', 'op_underfunded'),
    );
    await expect(payCtxOrder({ destination: 'GCTX', amount: '0.1', memo: 'm' })).rejects.toThrow(
      PayoutSubmitError,
    );
  });
});
