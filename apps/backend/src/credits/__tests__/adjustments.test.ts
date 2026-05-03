import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors the `refunds.test.ts` chainable-db pattern (A2-1701).
 *
 * `applyAdminCreditAdjustment` has two selects inside the txn:
 *   1. The A2-1610 daily-cap sum (`ABS(amount_minor)` for today)
 *   2. The FOR UPDATE read of the balance row
 *
 * The mock serves them in order: a `forUpdateResponses` queue lets a
 * single test stage the daily-cap sum first, then the balance row.
 * This is enough to exercise both the cap-exceeded path and the
 * balance-update paths without standing up a real DB.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    /**
     * Queue of responses served in FIFO order by `.for('update')` /
     * `.where(...)` awaits. The adjustment code hits two selects:
     * the daily-cap sum, then the forUpdate. Seed both in the queue
     * in that order.
     */
    forUpdateResponses: unknown[];
    insertCreditCalls: unknown[];
    insertUserCreditsCalls: unknown[];
    updateSets: unknown[];
    returnedCreditRow: unknown;
  }
  const s: State = {
    forUpdateResponses: [],
    insertCreditCalls: [],
    insertUserCreditsCalls: [],
    updateSets: [],
    returnedCreditRow: null,
  };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['execute'] = vi.fn(async () => []);
  // Both the cap-sum SELECT and the FOR UPDATE row land through `.where(...)`.
  // The daily-cap query terminates with the awaited `where` result (it does
  // not call `.for('update')`); the balance lock query chains `.for('update')`
  // after `.where`. So `.where` returns a thenable that the cap-sum query
  // awaits AND is chainable to `.for('update')` for the balance lock.
  chain['where'] = vi.fn(() => {
    const thenable: {
      then: (resolve: (v: unknown) => unknown) => unknown;
      for: ReturnType<typeof vi.fn>;
    } = {
      then: (resolve) => resolve(s.forUpdateResponses.shift() ?? []),
      for: vi.fn(async () => s.forUpdateResponses.shift() ?? []),
    };
    return thenable;
  });
  chain['insert'] = vi.fn((table: unknown) => {
    const name = (table as Record<string, unknown>)['__name'];
    (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'] =
      typeof name === 'string' ? name : undefined;
    return chain;
  });
  chain['values'] = vi.fn((v: unknown) => {
    const last = (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'];
    if (last === 'creditTransactions') s.insertCreditCalls.push(v);
    else if (last === 'userCredits') s.insertUserCreditsCalls.push(v);
    return chain;
  });
  chain['returning'] = vi.fn(async () => [s.returnedCreditRow]);
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: unknown) => {
    s.updateSets.push(v);
    return chain;
  });
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    __name: 'creditTransactions',
    type: 'type',
    referenceType: 'reference_type',
    referenceId: 'reference_id',
    currency: 'currency',
    createdAt: 'created_at',
    amountMinor: 'amount_minor',
  },
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    __name: 'userCredits',
  },
}));

const { envMock } = vi.hoisted(() => ({
  envMock: {
    ADMIN_DAILY_ADJUSTMENT_CAP_MINOR: 0n,
  },
}));
vi.mock('../../env.js', () => ({ env: envMock }));

import {
  applyAdminCreditAdjustment,
  InsufficientBalanceError,
  DailyAdjustmentLimitError,
} from '../adjustments.js';

beforeEach(() => {
  state.forUpdateResponses = [];
  state.insertCreditCalls = [];
  state.insertUserCreditsCalls = [];
  state.updateSets = [];
  state.returnedCreditRow = null;
  envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 0n;
  dbMock['execute']?.mockClear();
});

describe('applyAdminCreditAdjustment', () => {
  it('credits a new user (no prior balance row): inserts ct + inserts user_credits', async () => {
    // Cap disabled → skip cap query. FOR UPDATE returns no row.
    state.forUpdateResponses = [[]];
    state.returnedCreditRow = { id: 'ct-1', createdAt: new Date('2026-04-23') };

    const result = await applyAdminCreditAdjustment({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      adminUserId: 'admin-1',
      reason: 'goodwill credit',
    });

    expect(result.priorBalanceMinor).toBe(0n);
    expect(result.newBalanceMinor).toBe(500n);
    expect(result.amountMinor).toBe(500n);
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'adjustment',
      amountMinor: 500n,
      currency: 'USD',
      referenceType: 'admin_adjustment',
      referenceId: 'admin-1',
      reason: 'goodwill credit',
    });
    expect(state.insertUserCreditsCalls[0]).toMatchObject({
      userId: 'u-1',
      currency: 'USD',
      balanceMinor: 500n,
    });
    expect(state.updateSets).toHaveLength(0);
  });

  it('updates an existing balance row rather than inserting', async () => {
    state.forUpdateResponses = [[{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }]];
    state.returnedCreditRow = { id: 'ct-2', createdAt: new Date() };

    const result = await applyAdminCreditAdjustment({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      adminUserId: 'admin-1',
      reason: 'late accrual',
    });

    expect(result.priorBalanceMinor).toBe(2000n);
    expect(result.newBalanceMinor).toBe(2500n);
    expect(state.insertUserCreditsCalls).toHaveLength(0);
    expect(state.updateSets[0]).toMatchObject({ balanceMinor: 2500n });
  });

  it('applies a negative (debit) adjustment when the balance covers it', async () => {
    state.forUpdateResponses = [[{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }]];
    state.returnedCreditRow = { id: 'ct-3', createdAt: new Date() };

    const result = await applyAdminCreditAdjustment({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: -500n,
      adminUserId: 'admin-1',
      reason: 'bad-faith claim',
    });

    expect(result.priorBalanceMinor).toBe(2000n);
    expect(result.newBalanceMinor).toBe(1500n);
    expect(state.insertCreditCalls[0]).toMatchObject({
      type: 'adjustment',
      amountMinor: -500n,
    });
    expect(state.updateSets[0]).toMatchObject({ balanceMinor: 1500n });
  });

  it('throws InsufficientBalanceError when a debit would drive the balance negative', async () => {
    state.forUpdateResponses = [[{ userId: 'u-1', currency: 'USD', balanceMinor: 200n }]];
    state.returnedCreditRow = { id: 'ct-4', createdAt: new Date() };

    await expect(
      applyAdminCreditAdjustment({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: -500n,
        adminUserId: 'admin-1',
        reason: 'attempted overdraft',
      }),
    ).rejects.toThrow(InsufficientBalanceError);
    // No ct insert, no balance update: the txn rolled back before
    // reaching them (the throw happens before the insert).
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
    expect(state.insertUserCreditsCalls).toHaveLength(0);
  });

  it('includes the reason string on the ct row for ledger audit (A2-908)', async () => {
    state.forUpdateResponses = [[]];
    state.returnedCreditRow = { id: 'ct-5', createdAt: new Date() };
    await applyAdminCreditAdjustment({
      userId: 'u-1',
      currency: 'GBP',
      amountMinor: 100n,
      adminUserId: 'admin-1',
      reason: 'escalated support — ticket #443',
    });
    expect(state.insertCreditCalls[0]).toMatchObject({
      reason: 'escalated support — ticket #443',
    });
  });

  describe('A2-1610 daily per-admin cap', () => {
    it('skips the cap check when ADMIN_DAILY_ADJUSTMENT_CAP_MINOR is 0 (disabled)', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 0n;
      // Only the FOR UPDATE read is expected; no cap query.
      state.forUpdateResponses = [[]];
      state.returnedCreditRow = { id: 'ct-6', createdAt: new Date() };
      await expect(
        applyAdminCreditAdjustment({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 10_000_000n, // larger than the cap would allow if enabled
          adminUserId: 'admin-1',
          reason: 'promotional top-up',
        }),
      ).resolves.toBeDefined();
    });

    it('allows an adjustment when cumulative-abs + |amount| is under the cap', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1_000_000n;
      // Cap sum returns 400_000 used. Then FOR UPDATE returns no row.
      state.forUpdateResponses = [[{ usedMinor: '400000' }], []];
      state.returnedCreditRow = { id: 'ct-7', createdAt: new Date() };

      const result = await applyAdminCreditAdjustment({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500_000n,
        adminUserId: 'admin-1',
        reason: 'still under cap',
      });
      expect(result.newBalanceMinor).toBe(500_000n);
      expect(dbMock['execute']!).toHaveBeenCalledOnce();
    });

    it('rejects with DailyAdjustmentLimitError when |amount| + used > cap (positive delta)', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1_000_000n;
      state.forUpdateResponses = [[{ usedMinor: '900000' }]];
      await expect(
        applyAdminCreditAdjustment({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 200_000n,
          adminUserId: 'admin-1',
          reason: 'would overflow cap',
        }),
      ).rejects.toThrow(DailyAdjustmentLimitError);
      expect(state.insertCreditCalls).toHaveLength(0);
      expect(state.insertUserCreditsCalls).toHaveLength(0);
    });

    it('sums absolute value, so a large debit also trips the cap', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1_000_000n;
      state.forUpdateResponses = [[{ usedMinor: '900000' }]];
      await expect(
        applyAdminCreditAdjustment({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: -200_000n,
          adminUserId: 'admin-1',
          reason: 'debit also counts toward the magnitude cap',
        }),
      ).rejects.toThrow(DailyAdjustmentLimitError);
    });

    it('treats the cap as per-admin-per-currency — different currency writes are unaffected', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1_000n;
      // The admin handler filters by currency inside the cap SQL, so the
      // mock returns zero for a currency the admin hasn't touched today.
      state.forUpdateResponses = [[{ usedMinor: '0' }], []];
      state.returnedCreditRow = { id: 'ct-8', createdAt: new Date() };
      await expect(
        applyAdminCreditAdjustment({
          userId: 'u-1',
          currency: 'EUR',
          amountMinor: 500n,
          adminUserId: 'admin-1',
          reason: 'first EUR adjustment of the day',
        }),
      ).resolves.toBeDefined();
    });
  });
});
