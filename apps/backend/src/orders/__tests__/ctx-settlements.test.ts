import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, state } = vi.hoisted(() => {
  const s: {
    selectRows: unknown[];
    insertReturnRows: unknown[];
    valuesCalls: unknown[];
    conflictDoNothingArgs: unknown[];
    conflictDoUpdateArgs: unknown[];
    updateSets: unknown[];
    whereCalls: unknown[];
  } = {
    selectRows: [],
    insertReturnRows: [],
    valuesCalls: [],
    conflictDoNothingArgs: [],
    conflictDoUpdateArgs: [],
    updateSets: [],
    whereCalls: [],
  };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn((arg: unknown) => {
    s.whereCalls.push(arg);
    return chain;
  });
  chain['limit'] = vi.fn(async () => s.selectRows);
  chain['insert'] = vi.fn(() => chain);
  chain['values'] = vi.fn((v: unknown) => {
    s.valuesCalls.push(v);
    return chain;
  });
  chain['onConflictDoNothing'] = vi.fn((arg: unknown) => {
    s.conflictDoNothingArgs.push(arg);
    return chain;
  });
  chain['onConflictDoUpdate'] = vi.fn(async (arg: unknown) => {
    s.conflictDoUpdateArgs.push(arg);
    return undefined;
  });
  chain['returning'] = vi.fn(async () => s.insertReturnRows);
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: unknown) => {
    s.updateSets.push(v);
    return chain;
  });

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  ctxSettlements: {
    id: 'id',
    orderId: 'order_id',
    destination: 'destination',
    memoText: 'memo_text',
    amountStroops: 'amount_stroops',
    txHash: 'tx_hash',
    confirmedAt: 'confirmed_at',
  },
}));

import {
  backfillCtxSettlementFromChain,
  getCtxSettlementByOrderId,
  getOrCreateCtxSettlement,
  markCtxSettlementConfirmed,
  recordCtxSettlementTxHash,
} from '../ctx-settlements.js';

const settlement = {
  id: 'settlement-1',
  orderId: '00000000-0000-4000-8000-000000000001',
  destination: 'GCTXDEST',
  memoText: 'ctx-memo-1',
  amountStroops: 1_234_567n,
  txHash: null,
  confirmedAt: null,
  createdAt: new Date('2026-07-07T00:00:00Z'),
};

beforeEach(() => {
  state.selectRows = [];
  state.insertReturnRows = [];
  state.valuesCalls = [];
  state.conflictDoNothingArgs = [];
  state.conflictDoUpdateArgs = [];
  state.updateSets = [];
  state.whereCalls = [];
  for (const fn of Object.values(dbMock)) fn.mockClear();
});

describe('ctx-settlements repo', () => {
  it('looks up a settlement by order id', async () => {
    state.selectRows = [settlement];

    await expect(getCtxSettlementByOrderId(settlement.orderId)).resolves.toBe(settlement);

    expect(dbMock['select']).toHaveBeenCalledTimes(1);
    expect(dbMock['from']).toHaveBeenCalledTimes(1);
    expect(dbMock['where']).toHaveBeenCalledTimes(1);
    expect(dbMock['limit']).toHaveBeenCalledWith(1);
  });

  it('returns null when no settlement exists for the order id', async () => {
    state.selectRows = [];

    await expect(getCtxSettlementByOrderId(settlement.orderId)).resolves.toBeNull();
  });

  it('creates the first settlement intent row for an order', async () => {
    state.insertReturnRows = [settlement];

    await expect(
      getOrCreateCtxSettlement({
        orderId: settlement.orderId,
        destination: settlement.destination,
        memoText: settlement.memoText,
        amountStroops: settlement.amountStroops,
      }),
    ).resolves.toBe(settlement);

    expect(state.valuesCalls[0]).toEqual({
      orderId: settlement.orderId,
      destination: settlement.destination,
      memoText: settlement.memoText,
      amountStroops: settlement.amountStroops,
    });
    expect(dbMock['onConflictDoNothing']).toHaveBeenCalledTimes(1);
    expect(dbMock['returning']).toHaveBeenCalledTimes(1);
    expect(dbMock['select']).not.toHaveBeenCalled();
  });

  it('returns the existing settlement intent when insert loses the per-order race', async () => {
    state.insertReturnRows = [];
    state.selectRows = [settlement];

    await expect(
      getOrCreateCtxSettlement({
        orderId: settlement.orderId,
        destination: settlement.destination,
        memoText: settlement.memoText,
        amountStroops: settlement.amountStroops,
      }),
    ).resolves.toBe(settlement);

    expect(dbMock['onConflictDoNothing']).toHaveBeenCalledTimes(1);
    expect(dbMock['select']).toHaveBeenCalledTimes(1);
  });

  it('fails loudly if an insert conflict cannot be re-read', async () => {
    state.insertReturnRows = [];
    state.selectRows = [];

    await expect(
      getOrCreateCtxSettlement({
        orderId: settlement.orderId,
        destination: settlement.destination,
        memoText: settlement.memoText,
        amountStroops: settlement.amountStroops,
      }),
    ).rejects.toThrow(/insert conflicted but no row found/);
  });

  it('persists the signed transaction hash before submit', async () => {
    await recordCtxSettlementTxHash({ id: settlement.id, txHash: 'tx-hash-1' });

    expect(dbMock['update']).toHaveBeenCalledTimes(1);
    expect(state.updateSets).toEqual([{ txHash: 'tx-hash-1' }]);
    expect(dbMock['where']).toHaveBeenCalledTimes(1);
  });

  it('marks a settlement confirmed when Horizon proves the tx landed', async () => {
    await markCtxSettlementConfirmed(settlement.id);

    expect(dbMock['update']).toHaveBeenCalledTimes(1);
    expect(state.updateSets).toHaveLength(1);
    expect(state.updateSets[0]).toHaveProperty('confirmedAt');
  });

  it('backfills a landed chain payment into a confirmed settlement row', async () => {
    await backfillCtxSettlementFromChain({
      orderId: settlement.orderId,
      destination: settlement.destination,
      memoText: settlement.memoText,
      amountStroops: settlement.amountStroops,
      txHash: 'landed-tx',
    });

    expect(state.valuesCalls[0]).toMatchObject({
      orderId: settlement.orderId,
      destination: settlement.destination,
      memoText: settlement.memoText,
      amountStroops: settlement.amountStroops,
      txHash: 'landed-tx',
    });
    expect(state.valuesCalls[0]).toHaveProperty('confirmedAt');
    expect(dbMock['onConflictDoUpdate']).toHaveBeenCalledTimes(1);
    expect(state.conflictDoUpdateArgs[0]).toMatchObject({
      set: { txHash: 'landed-tx' },
    });
    expect((state.conflictDoUpdateArgs[0] as { set: object }).set).toHaveProperty('confirmedAt');
  });
});
