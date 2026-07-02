import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as PayoutSubmitModule from '../../payments/payout-submit.js';

vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] ??= 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

// Mock the operator-pool resolver (returns null when unset, or
// a fully-shaped config when set). Each test sets `cfgState.current`.
const { cfgState, submitMock, findOutboundMock, hashLookupMock, settlementStore, repoMocks } =
  vi.hoisted(() => {
    interface StoredSettlement {
      id: string;
      orderId: string;
      destination: string;
      memoText: string;
      amountStroops: bigint;
      txHash: string | null;
      confirmedAt: Date | null;
      createdAt: Date;
    }
    const settlementStore = new Map<string, StoredSettlement>();
    let nextId = 1;
    return {
      settlementStore,
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
      hashLookupMock: vi.fn(),
      // In-memory emulation of the ctx-settlements repo (hardening A4)
      // — same contract as the real module; SQL behaviour is pinned by
      // the integration suite.
      repoMocks: {
        getCtxSettlementByOrderId: vi.fn(
          async (orderId: string) =>
            [...settlementStore.values()].find((s) => s.orderId === orderId) ?? null,
        ),
        getOrCreateCtxSettlement: vi.fn(
          async (args: {
            orderId: string;
            destination: string;
            memoText: string;
            amountStroops: bigint;
          }) => {
            const existing = [...settlementStore.values()].find((s) => s.orderId === args.orderId);
            if (existing !== undefined) return existing;
            const row: StoredSettlement = {
              id: `settlement-${nextId++}`,
              ...args,
              txHash: null,
              confirmedAt: null,
              createdAt: new Date(),
            };
            settlementStore.set(row.id, row);
            return row;
          },
        ),
        recordCtxSettlementTxHash: vi.fn(async (args: { id: string; txHash: string }) => {
          const row = settlementStore.get(args.id);
          if (row !== undefined) row.txHash = args.txHash;
        }),
        markCtxSettlementConfirmed: vi.fn(async (id: string) => {
          const row = settlementStore.get(id);
          if (row !== undefined) row.confirmedAt = new Date();
        }),
        backfillCtxSettlementFromChain: vi.fn(
          async (args: {
            orderId: string;
            destination: string;
            memoText: string;
            amountStroops: bigint;
            txHash: string;
          }) => {
            const existing = [...settlementStore.values()].find((s) => s.orderId === args.orderId);
            if (existing !== undefined) {
              existing.txHash = args.txHash;
              existing.confirmedAt = new Date();
              return;
            }
            settlementStore.set(`settlement-${nextId++}`, {
              id: `settlement-${nextId}`,
              orderId: args.orderId,
              destination: args.destination,
              memoText: args.memoText,
              amountStroops: args.amountStroops,
              txHash: args.txHash,
              confirmedAt: new Date(),
              createdAt: new Date(),
            });
          },
        ),
      },
    };
  });

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
vi.mock('../../payments/horizon.js', () => ({
  getOutboundPaymentByTxHash: (...args: unknown[]) => hashLookupMock(...args),
}));
vi.mock('../ctx-settlements.js', () => ({
  getCtxSettlementByOrderId: (orderId: string) => repoMocks.getCtxSettlementByOrderId(orderId),
  getOrCreateCtxSettlement: (args: Parameters<typeof repoMocks.getOrCreateCtxSettlement>[0]) =>
    repoMocks.getOrCreateCtxSettlement(args),
  recordCtxSettlementTxHash: (args: Parameters<typeof repoMocks.recordCtxSettlementTxHash>[0]) =>
    repoMocks.recordCtxSettlementTxHash(args),
  markCtxSettlementConfirmed: (id: string) => repoMocks.markCtxSettlementConfirmed(id),
  backfillCtxSettlementFromChain: (
    args: Parameters<typeof repoMocks.backfillCtxSettlementFromChain>[0],
  ) => repoMocks.backfillCtxSettlementFromChain(args),
}));

import {
  payCtxOrder,
  PayCtxConfigError,
  PayCtxReconcileError,
  decimalToStroops,
} from '../pay-ctx.js';
import { PayoutSubmitError } from '../../payments/payout-submit.js';

const ORDER = '00000000-0000-4000-8000-00000000feed';
const BASE_ARGS = { orderId: ORDER, destination: 'GCTX', amount: '0.1', memo: 'order-1' };

beforeEach(() => {
  submitMock.mockReset();
  findOutboundMock.mockReset();
  hashLookupMock.mockReset();
  settlementStore.clear();
  for (const m of Object.values(repoMocks)) m.mockClear();
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
  it('submits a native XLM payment when no prior submit exists anywhere', async () => {
    findOutboundMock.mockResolvedValueOnce(null);
    submitMock.mockResolvedValueOnce({ txHash: 'new-tx', ledger: 1 });
    const r = await payCtxOrder(BASE_ARGS);
    expect(r).toEqual({ txHash: 'new-tx', submitted: true });
    expect(findOutboundMock).toHaveBeenCalledWith({
      account: 'GOP',
      to: 'GCTX',
      memo: 'order-1',
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
    const submitArgs = submitMock.mock.calls[0]![0] as { intent: Record<string, unknown> };
    expect(submitArgs.intent).toMatchObject({ to: 'GCTX', amount: '0.1', memoText: 'order-1' });
    // A4: the settlement intent row was created and confirmed.
    expect(repoMocks.getOrCreateCtxSettlement).toHaveBeenCalledWith({
      orderId: ORDER,
      destination: 'GCTX',
      memoText: 'order-1',
      amountStroops: 1_000_000n,
    });
    expect(repoMocks.markCtxSettlementConfirmed).toHaveBeenCalledTimes(1);
  });

  it('A4: converges via the authoritative hash lookup without any memo scan', async () => {
    // A prior attempt persisted its hash before submitting, then the
    // process crashed. The re-run must use the point lookup — immune
    // to the history window — and never re-submit.
    settlementStore.set('s1', {
      id: 's1',
      orderId: ORDER,
      destination: 'GCTX',
      memoText: 'order-1',
      amountStroops: 1_000_000n,
      txHash: 'persisted-tx',
      confirmedAt: null,
      createdAt: new Date(),
    });
    hashLookupMock.mockResolvedValueOnce({ landed: true });

    const r = await payCtxOrder(BASE_ARGS);
    expect(r).toEqual({ txHash: 'persisted-tx', submitted: false });
    expect(hashLookupMock).toHaveBeenCalledWith('persisted-tx');
    expect(findOutboundMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(repoMocks.markCtxSettlementConfirmed).toHaveBeenCalledWith('s1');
  });

  it('A4: a persisted hash that never landed falls through to a fresh submit', async () => {
    settlementStore.set('s1', {
      id: 's1',
      orderId: ORDER,
      destination: 'GCTX',
      memoText: 'order-1',
      amountStroops: 1_000_000n,
      txHash: 'never-landed-tx',
      confirmedAt: null,
      createdAt: new Date(),
    });
    hashLookupMock.mockResolvedValueOnce(null);
    findOutboundMock.mockResolvedValueOnce(null);
    submitMock.mockResolvedValueOnce({ txHash: 'fresh-tx', ledger: 2 });

    const r = await payCtxOrder(BASE_ARGS);
    expect(r).toEqual({ txHash: 'fresh-tx', submitted: true });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('A4: persists the signed hash BEFORE the network submit (onSigned wired)', async () => {
    findOutboundMock.mockResolvedValueOnce(null);
    submitMock.mockImplementationOnce(async (args: { onSigned?: (h: string) => Promise<void> }) => {
      // Emulate submitNativePayment's contract: onSigned fires with
      // the deterministic hash before the network call.
      await args.onSigned?.('signed-ahead-tx');
      return { txHash: 'signed-ahead-tx', ledger: 3 };
    });
    await payCtxOrder(BASE_ARGS);
    const row = [...settlementStore.values()][0]!;
    expect(row.txHash).toBe('signed-ahead-tx');
    expect(repoMocks.recordCtxSettlementTxHash).toHaveBeenCalledTimes(1);
  });

  it('A4: refuses when the pinned settlement intent mismatches this attempt (rotated URI)', async () => {
    settlementStore.set('s1', {
      id: 's1',
      orderId: ORDER,
      destination: 'G-DIFFERENT-DESTINATION',
      memoText: 'order-1',
      amountStroops: 1_000_000n,
      txHash: null,
      confirmedAt: null,
      createdAt: new Date(),
    });
    await expect(payCtxOrder(BASE_ARGS)).rejects.toThrow(PayCtxReconcileError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('skips submit + backfills the record when the memo scan finds a matching payment', async () => {
    findOutboundMock.mockResolvedValueOnce({ txHash: 'prior-tx', amount: '0.1', assetCode: null });
    const r = await payCtxOrder(BASE_ARGS);
    expect(r).toEqual({ txHash: 'prior-tx', submitted: false });
    expect(submitMock).not.toHaveBeenCalled();
    expect(repoMocks.backfillCtxSettlementFromChain).toHaveBeenCalledWith({
      orderId: ORDER,
      destination: 'GCTX',
      memoText: 'order-1',
      amountStroops: 1_000_000n,
      txHash: 'prior-tx',
    });
  });

  it('skips submit when the prior amount differs only in trailing-zero format', async () => {
    findOutboundMock.mockResolvedValueOnce({
      txHash: 'prior-tx',
      amount: '0.1000000',
      assetCode: null,
    });
    const r = await payCtxOrder(BASE_ARGS);
    expect(r).toEqual({ txHash: 'prior-tx', submitted: false });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('throws PayCtxReconcileError when a memo match has a different amount (collision)', async () => {
    findOutboundMock.mockResolvedValueOnce({ txHash: 'prior-tx', amount: '0.05', assetCode: null });
    await expect(payCtxOrder(BASE_ARGS)).rejects.toThrow(PayCtxReconcileError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('throws PayCtxReconcileError when a memo match is a non-native asset', async () => {
    findOutboundMock.mockResolvedValueOnce({
      txHash: 'prior-tx',
      amount: '0.1',
      assetCode: 'USDC',
    });
    await expect(payCtxOrder(BASE_ARGS)).rejects.toThrow(PayCtxReconcileError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('throws PayCtxReconcileError on an unparseable amount before touching anything', async () => {
    await expect(payCtxOrder({ ...BASE_ARGS, amount: 'NaN-ish' })).rejects.toThrow(
      PayCtxReconcileError,
    );
    expect(findOutboundMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('throws PayCtxConfigError when LOOP_STELLAR_OPERATOR_SECRET is unset', async () => {
    cfgState.current = null;
    await expect(payCtxOrder(BASE_ARGS)).rejects.toThrow(PayCtxConfigError);
  });

  it('propagates PayoutSubmitError from the submit step', async () => {
    findOutboundMock.mockResolvedValueOnce(null);
    submitMock.mockRejectedValueOnce(
      new PayoutSubmitError('terminal_underfunded', 'op_underfunded'),
    );
    await expect(payCtxOrder(BASE_ARGS)).rejects.toThrow(PayoutSubmitError);
  });
});

describe('decimalToStroops', () => {
  it('parses whole and fractional XLM amounts', () => {
    expect(decimalToStroops('0.1')).toBe(1_000_000n);
    expect(decimalToStroops('0.1000000')).toBe(1_000_000n);
    expect(decimalToStroops('1')).toBe(10_000_000n);
    expect(decimalToStroops('0.1226242')).toBe(1_226_242n);
    expect(decimalToStroops(' 0.05 ')).toBe(500_000n);
  });
  it('returns null for non-decimal or over-precise strings', () => {
    expect(decimalToStroops('')).toBeNull();
    expect(decimalToStroops('abc')).toBeNull();
    expect(decimalToStroops('0.12345678')).toBeNull(); // > 7 dp
    expect(decimalToStroops('1.2.3')).toBeNull();
  });
});
