import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));
vi.mock('../../discord.js', () => ({
  notifyDuplicateAccountSignal: (args: unknown) => notifyMock(args),
}));

const { dbState, dbMock } = vi.hoisted(() => {
  const s: {
    selectRows: Array<{ userId: string; id: string }>;
    selectThrows: Error | null;
    insertReturns: Array<Array<{ id: string }>>;
    insertThrows: Error | null;
    insertCalls: Array<{ values: unknown; target: unknown }>;
  } = {
    selectRows: [],
    selectThrows: null,
    insertReturns: [],
    insertThrows: null,
    insertCalls: [],
  };
  const selectChain: Record<string, unknown> = {};
  selectChain['select'] = vi.fn(() => selectChain);
  selectChain['from'] = vi.fn(() => selectChain);
  selectChain['where'] = vi.fn(() => selectChain);
  selectChain['limit'] = vi.fn(async () => {
    if (s.selectThrows !== null) throw s.selectThrows;
    return s.selectRows;
  });

  let pendingInsertValues: unknown = null;
  let pendingTarget: unknown = null;
  const insertChain: Record<string, unknown> = {};
  insertChain['insert'] = vi.fn(() => insertChain);
  insertChain['values'] = vi.fn((v: unknown) => {
    pendingInsertValues = v;
    return insertChain;
  });
  insertChain['onConflictDoNothing'] = vi.fn((opts: { target: unknown }) => {
    pendingTarget = opts.target;
    return insertChain;
  });
  insertChain['returning'] = vi.fn(async () => {
    if (s.insertThrows !== null) throw s.insertThrows;
    s.insertCalls.push({ values: pendingInsertValues, target: pendingTarget });
    const next = s.insertReturns.shift();
    return next ?? [{ id: 'signal-id' }];
  });

  const m = { ...selectChain, ...insertChain };
  return { dbState: s, dbMock: m };
});
vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: { userId: 'user_id', id: 'id', paymentReceivedPayment: 'payment_received_payment' },
  fraudSignals: {
    signalType: 'signal_type',
    userId: 'user_id',
    relatedUserId: 'related_user_id',
    id: 'id',
  },
}));

import { checkDuplicateFundingSource } from '../duplicate-account-signals.js';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  dbState.selectRows = [];
  dbState.selectThrows = null;
  dbState.insertReturns = [];
  dbState.insertThrows = null;
  dbState.insertCalls = [];
  notifyMock.mockClear();
});

describe('checkDuplicateFundingSource', () => {
  it('no-ops when no other user shares the funding source', async () => {
    dbState.selectRows = [];
    await checkDuplicateFundingSource({
      userId: USER_A,
      orderId: 'order-1',
      sourceAccount: 'GSOURCE',
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('no-ops immediately on an empty source account (no query at all)', async () => {
    await checkDuplicateFundingSource({ userId: USER_A, orderId: 'order-1', sourceAccount: '' });
    expect(dbState.insertCalls).toEqual([]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('writes a fraud_signals row and notifies on a fresh match', async () => {
    dbState.selectRows = [{ userId: USER_B, id: 'order-related' }];
    await checkDuplicateFundingSource({
      userId: USER_A,
      orderId: 'order-1',
      sourceAccount: 'GSOURCE',
    });
    expect(dbState.insertCalls).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAccount: 'GSOURCE',
        orderId: 'order-1',
        relatedOrderId: 'order-related',
      }),
    );
  });

  it('canonicalizes the (userId, relatedUserId) pair regardless of call direction', async () => {
    // USER_A < USER_B lexicographically — the canonical pair should
    // always be (USER_A, USER_B) whichever side's order triggered
    // the detection.
    dbState.selectRows = [{ userId: USER_B, id: 'order-b' }];
    await checkDuplicateFundingSource({
      userId: USER_A,
      orderId: 'order-a',
      sourceAccount: 'GSOURCE',
    });
    const call = dbState.insertCalls[0]?.values as { userId: string; relatedUserId: string };
    expect(call.userId).toBe(USER_A);
    expect(call.relatedUserId).toBe(USER_B);
  });

  it('does not notify when the pair is already known (ON CONFLICT DO NOTHING)', async () => {
    dbState.selectRows = [{ userId: USER_B, id: 'order-related' }];
    dbState.insertReturns = [[]]; // conflict — no row inserted
    await checkDuplicateFundingSource({
      userId: USER_A,
      orderId: 'order-1',
      sourceAccount: 'GSOURCE',
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('dedupes to distinct related userIds before writing', async () => {
    dbState.selectRows = [
      { userId: USER_B, id: 'order-b1' },
      { userId: USER_B, id: 'order-b2' },
    ];
    await checkDuplicateFundingSource({
      userId: USER_A,
      orderId: 'order-1',
      sourceAccount: 'GSOURCE',
    });
    expect(dbState.insertCalls).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the lookup query fails — detection-only, non-blocking', async () => {
    dbState.selectThrows = new Error('db down');
    await expect(
      checkDuplicateFundingSource({ userId: USER_A, orderId: 'order-1', sourceAccount: 'GSOURCE' }),
    ).resolves.toBeUndefined();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('never throws when the insert fails — detection-only, non-blocking', async () => {
    dbState.selectRows = [{ userId: USER_B, id: 'order-related' }];
    dbState.insertThrows = new Error('constraint violation');
    await expect(
      checkDuplicateFundingSource({ userId: USER_A, orderId: 'order-1', sourceAccount: 'GSOURCE' }),
    ).resolves.toBeUndefined();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
