import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: {
    id: 'id',
    userId: 'user_id',
    orderId: 'order_id',
    state: 'state',
    attempts: 'attempts',
    createdAt: 'created_at',
  },
}));

// Chain mock — separate objects for insert/update/select so each
// chain's terminal call can resolve to a distinct row set. All vi.fn
// instances are hoisted alongside the state so the vi.mock() factory
// below (itself hoisted above the file) can reference them.
const { insertChain, updateChain, selectChain, state, insertSpy, updateSpy, selectSpy } =
  vi.hoisted(() => {
    const s: {
      insertReturn: unknown;
      updateReturn: unknown;
      selectReturn: unknown[];
    } = {
      insertReturn: null,
      updateReturn: null,
      selectReturn: [],
    };
    const ins: Record<string, ReturnType<typeof vi.fn>> = {};
    ins['values'] = vi.fn(() => ins);
    ins['onConflictDoNothing'] = vi.fn(() => ins);
    ins['returning'] = vi.fn(async () => (s.insertReturn === null ? [] : [s.insertReturn]));
    const upd: Record<string, ReturnType<typeof vi.fn>> = {};
    upd['set'] = vi.fn(() => upd);
    upd['where'] = vi.fn(() => upd);
    upd['returning'] = vi.fn(async () => (s.updateReturn === null ? [] : [s.updateReturn]));
    const sel: Record<string, ReturnType<typeof vi.fn>> = {};
    sel['from'] = vi.fn(() => sel);
    sel['where'] = vi.fn(() => sel);
    sel['orderBy'] = vi.fn(() => sel);
    sel['limit'] = vi.fn(async () => s.selectReturn);
    return {
      insertChain: ins,
      updateChain: upd,
      selectChain: sel,
      state: s,
      insertSpy: vi.fn(() => ins),
      updateSpy: vi.fn(() => upd),
      selectSpy: vi.fn(() => sel),
    };
  });

vi.mock('../../db/client.js', () => ({
  db: {
    insert: insertSpy,
    update: updateSpy,
    select: selectSpy,
  },
}));

import {
  insertPayout,
  listPendingPayouts,
  listPayoutsForAdmin,
  markPayoutSubmitted,
  markPayoutConfirmed,
  markPayoutFailed,
  resetPayoutToPending,
} from '../pending-payouts.js';

const INTENT = {
  to: 'GDESTINATION',
  assetCode: 'GBPLOOP',
  assetIssuer: 'GISSUER',
  amountStroops: 50_000_000n,
  memoText: 'order-1',
};

beforeEach(() => {
  state.insertReturn = null;
  state.updateReturn = null;
  state.selectReturn = [];
  insertSpy.mockClear();
  updateSpy.mockClear();
  selectSpy.mockClear();
  for (const chain of [insertChain, updateChain, selectChain]) {
    for (const fn of Object.values(chain)) {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as unknown as { mockClear: () => void }).mockClear();
      }
    }
  }
});

describe('insertPayout', () => {
  it('returns the inserted row when no conflict', async () => {
    state.insertReturn = { id: 'p-1', state: 'pending' };
    const row = await insertPayout({ userId: 'u', orderId: 'o-1', intent: INTENT });
    expect(row).toEqual({ id: 'p-1', state: 'pending' });
    expect(insertChain['values']!).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u',
        orderId: 'o-1',
        toAddress: 'GDESTINATION',
        assetCode: 'GBPLOOP',
        amountStroops: 50_000_000n,
      }),
    );
  });

  it('returns null on unique-conflict (order already has a payout row)', async () => {
    state.insertReturn = null;
    const row = await insertPayout({ userId: 'u', orderId: 'o-1', intent: INTENT });
    expect(row).toBeNull();
  });
});

describe('listPendingPayouts', () => {
  it('queries pending rows ordered by createdAt ASC', async () => {
    state.selectReturn = [
      { id: 'p-1', state: 'pending', createdAt: new Date('2026-04-21T10:00:00Z') },
      { id: 'p-2', state: 'pending', createdAt: new Date('2026-04-21T11:00:00Z') },
    ];
    const rows = await listPendingPayouts(20);
    expect(rows).toHaveLength(2);
    expect(selectChain['limit']!).toHaveBeenCalledWith(20);
  });

  it('defaults limit to 20', async () => {
    state.selectReturn = [];
    await listPendingPayouts();
    expect(selectChain['limit']!).toHaveBeenCalledWith(20);
  });
});

describe('listPayoutsForAdmin', () => {
  it('clamps limit to 1..100', async () => {
    state.selectReturn = [];
    await listPayoutsForAdmin({ limit: 999 });
    expect(selectChain['limit']!).toHaveBeenLastCalledWith(100);

    await listPayoutsForAdmin({ limit: 0 });
    expect(selectChain['limit']!).toHaveBeenLastCalledWith(1);
  });

  it('defaults limit to 20 when omitted', async () => {
    state.selectReturn = [];
    await listPayoutsForAdmin({});
    expect(selectChain['limit']!).toHaveBeenLastCalledWith(20);
  });

  it('passes through the row set unchanged', async () => {
    state.selectReturn = [{ id: 'p-9', state: 'failed' }];
    const rows = await listPayoutsForAdmin({ state: 'failed' });
    expect(rows).toEqual([{ id: 'p-9', state: 'failed' }]);
  });
});

describe('markPayoutSubmitted', () => {
  it('returns the updated row on a successful pending → submitted transition', async () => {
    state.updateReturn = { id: 'p-1', state: 'submitted', attempts: 1 };
    const row = await markPayoutSubmitted('p-1');
    expect(row?.state).toBe('submitted');
  });

  it('returns null when another worker already claimed the row', async () => {
    state.updateReturn = null;
    const row = await markPayoutSubmitted('p-1');
    expect(row).toBeNull();
  });
});

describe('markPayoutConfirmed', () => {
  it('returns the confirmed row with txHash set', async () => {
    state.updateReturn = { id: 'p-1', state: 'confirmed', txHash: 'abc' };
    const row = await markPayoutConfirmed({ id: 'p-1', txHash: 'abc' });
    expect(row?.state).toBe('confirmed');
    expect(row?.txHash).toBe('abc');
    expect(updateChain['set']!).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'confirmed',
        txHash: 'abc',
        lastError: null,
      }),
    );
  });

  it('returns null when the row is not in submitted state', async () => {
    state.updateReturn = null;
    const row = await markPayoutConfirmed({ id: 'p-1', txHash: 'abc' });
    expect(row).toBeNull();
  });
});

describe('markPayoutFailed', () => {
  it('records the error and transitions to failed', async () => {
    state.updateReturn = { id: 'p-1', state: 'failed', lastError: 'Horizon 503' };
    const row = await markPayoutFailed({ id: 'p-1', reason: 'Horizon 503' });
    expect(row?.state).toBe('failed');
    expect(row?.lastError).toBe('Horizon 503');
  });

  it('truncates the error message at 500 chars', async () => {
    state.updateReturn = { id: 'p-1', state: 'failed', lastError: 'x'.repeat(500) };
    await markPayoutFailed({ id: 'p-1', reason: 'x'.repeat(1000) });
    expect(updateChain['set']!).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'x'.repeat(500),
      }),
    );
  });

  it('returns null when the row is already confirmed or failed', async () => {
    state.updateReturn = null;
    const row = await markPayoutFailed({ id: 'p-1', reason: 'err' });
    expect(row).toBeNull();
  });
});

describe('resetPayoutToPending', () => {
  it('returns the reset row when it was previously failed', async () => {
    state.updateReturn = { id: 'p-1', state: 'pending', lastError: null };
    const row = await resetPayoutToPending('p-1');
    expect(row?.state).toBe('pending');
  });

  it('returns null when the row was not in failed state (confirmed stays confirmed)', async () => {
    state.updateReturn = null;
    const row = await resetPayoutToPending('p-1');
    expect(row).toBeNull();
  });
});
