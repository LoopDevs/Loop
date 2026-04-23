import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors the credit-adjustments repo test pattern. db.transaction(cb)
 * calls cb with a chainable mock; each call records the writes so
 * assertions can read them back.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    forUpdateRows: unknown[];
    insertCreditCalls: unknown[];
    insertUserCreditsCalls: unknown[];
    updateSets: unknown[];
    returnedCreditRow: unknown;
    // Error to throw from the credit_transactions insert .returning() —
    // simulates a DB unique-violation for the duplicate-refund case.
    creditInsertError: Error | null;
  }
  const s: State = {
    forUpdateRows: [],
    insertCreditCalls: [],
    insertUserCreditsCalls: [],
    updateSets: [],
    returnedCreditRow: null,
    creditInsertError: null,
  };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => chain);
  chain['for'] = vi.fn(async () => s.forUpdateRows);
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
  chain['returning'] = vi.fn(async () => {
    if (s.creditInsertError !== null) throw s.creditInsertError;
    return [s.returnedCreditRow];
  });
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
  creditTransactions: { __name: 'creditTransactions' },
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    __name: 'userCredits',
  },
}));

import { applyAdminRefund, RefundAlreadyIssuedError } from '../refunds.js';

beforeEach(() => {
  state.forUpdateRows = [];
  state.insertCreditCalls = [];
  state.insertUserCreditsCalls = [];
  state.updateSets = [];
  state.returnedCreditRow = null;
  state.creditInsertError = null;
});

describe('applyAdminRefund', () => {
  it('happy path: inserts refund row + creates balance row when user has no prior balance', async () => {
    state.returnedCreditRow = { id: 'ct-1', createdAt: new Date('2026-04-23') };
    const result = await applyAdminRefund({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      orderId: 'o-1',
      adminUserId: 'admin-1',
    });
    expect(result.amountMinor).toBe(500n);
    expect(result.priorBalanceMinor).toBe(0n);
    expect(result.newBalanceMinor).toBe(500n);
    // Credit row: positive, type='refund', order reference.
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'refund',
      amountMinor: 500n,
      currency: 'USD',
      referenceType: 'order',
      referenceId: 'o-1',
    });
    // No prior row → inserted a new user_credits row.
    expect(state.insertUserCreditsCalls[0]).toMatchObject({
      userId: 'u-1',
      currency: 'USD',
      balanceMinor: 500n,
    });
  });

  it('bumps an existing balance row rather than inserting', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.returnedCreditRow = { id: 'ct-2', createdAt: new Date() };
    const result = await applyAdminRefund({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      orderId: 'o-1',
      adminUserId: 'admin-1',
    });
    expect(result.priorBalanceMinor).toBe(2000n);
    expect(result.newBalanceMinor).toBe(2500n);
    // Existing row path updates, doesn't re-insert.
    expect(state.insertUserCreditsCalls).toHaveLength(0);
    expect(state.updateSets[0]).toMatchObject({ balanceMinor: 2500n });
  });

  it('rejects a zero / negative amount before touching the db', async () => {
    await expect(
      applyAdminRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 0n,
        orderId: 'o-1',
        adminUserId: 'admin-1',
      }),
    ).rejects.toThrow(/Refund amount must be positive/);
    await expect(
      applyAdminRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: -100n,
        orderId: 'o-1',
        adminUserId: 'admin-1',
      }),
    ).rejects.toThrow(/Refund amount must be positive/);
  });

  it('A2-901: translates the partial-unique-index violation to RefundAlreadyIssuedError', async () => {
    const pgErr = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'credit_transactions_reference_unique',
    });
    state.creditInsertError = pgErr;
    await expect(
      applyAdminRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        orderId: 'o-dup',
        adminUserId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(RefundAlreadyIssuedError);
  });

  it('rethrows unrelated pg errors', async () => {
    state.creditInsertError = Object.assign(new Error('fk violation'), {
      code: '23503',
      constraint_name: 'credit_transactions_user_id_users_id_fk',
    });
    await expect(
      applyAdminRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        orderId: 'o-x',
        adminUserId: 'admin-1',
      }),
    ).rejects.not.toBeInstanceOf(RefundAlreadyIssuedError);
  });
});
