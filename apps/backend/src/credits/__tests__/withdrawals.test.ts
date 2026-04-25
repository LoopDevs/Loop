import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors the refunds.test.ts pattern. db.transaction(cb) calls cb
 * with a chainable mock; each call records the writes so assertions
 * can read them back. The withdrawal writer additionally inserts a
 * pending_payouts row before the credit_transactions row, so we
 * track that table separately.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    forUpdateRows: unknown[];
    insertCreditCalls: unknown[];
    insertUserCreditsCalls: unknown[];
    insertPayoutCalls: unknown[];
    updateSets: unknown[];
    returnedCreditRow: unknown;
    returnedPayoutRow: unknown;
    creditInsertError: Error | null;
  }
  const s: State = {
    forUpdateRows: [],
    insertCreditCalls: [],
    insertUserCreditsCalls: [],
    insertPayoutCalls: [],
    updateSets: [],
    returnedCreditRow: null,
    returnedPayoutRow: null,
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
    else if (last === 'pendingPayouts') s.insertPayoutCalls.push(v);
    return chain;
  });
  chain['returning'] = vi.fn(async () => {
    const last = (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'];
    if (last === 'creditTransactions') {
      if (s.creditInsertError !== null) throw s.creditInsertError;
      return [s.returnedCreditRow];
    }
    if (last === 'pendingPayouts') {
      return [s.returnedPayoutRow];
    }
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
  pendingPayouts: { __name: 'pendingPayouts', orderId: 'order_id' },
}));

import { applyAdminWithdrawal, WithdrawalAlreadyIssuedError } from '../withdrawals.js';
import { InsufficientBalanceError } from '../adjustments.js';

const intent = {
  assetCode: 'USDLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GUSER',
  amountStroops: 5_000_000n,
  memoText: 'WITHDRAW1',
};

beforeEach(() => {
  state.forUpdateRows = [];
  state.insertCreditCalls = [];
  state.insertUserCreditsCalls = [];
  state.insertPayoutCalls = [];
  state.updateSets = [];
  state.returnedCreditRow = null;
  state.returnedPayoutRow = null;
  state.creditInsertError = null;
});

describe('applyAdminWithdrawal (A2-901 / ADR-024)', () => {
  it('happy path: queues payout + writes negative credit-tx + decrements balance', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.returnedPayoutRow = { id: 'p-1' };
    state.returnedCreditRow = { id: 'ct-1', createdAt: new Date('2026-04-25') };
    const result = await applyAdminWithdrawal({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      intent,
      reason: 'support ticket #4823',
    });
    expect(result).toMatchObject({
      id: 'ct-1',
      payoutId: 'p-1',
      amountMinor: 500n,
      priorBalanceMinor: 2000n,
      newBalanceMinor: 1500n,
    });
    // Pending payout written first with kind=withdrawal + no orderId.
    expect(state.insertPayoutCalls[0]).toMatchObject({
      userId: 'u-1',
      kind: 'withdrawal',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      toAddress: 'GUSER',
      amountStroops: 5_000_000n,
      memoText: 'WITHDRAW1',
    });
    expect(state.insertPayoutCalls[0]).not.toHaveProperty('orderId');
    // Credit-tx row: NEGATIVE amount, type=withdrawal, ref=payout/<id>.
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'withdrawal',
      amountMinor: -500n,
      currency: 'USD',
      referenceType: 'payout',
      referenceId: 'p-1',
      reason: 'support ticket #4823',
    });
    // Balance updated, not inserted.
    expect(state.insertUserCreditsCalls).toHaveLength(0);
    expect(state.updateSets[0]).toMatchObject({ balanceMinor: 1500n });
  });

  it('rejects when balance < amount with InsufficientBalanceError', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 100n }];
    state.returnedPayoutRow = { id: 'p-x' };
    state.returnedCreditRow = { id: 'ct-x', createdAt: new Date() };
    await expect(
      applyAdminWithdrawal({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
        reason: 'r',
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    // Balance check fails before any insert runs.
    expect(state.insertPayoutCalls).toHaveLength(0);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('rejects when no balance row exists at all (treated as 0 balance)', async () => {
    state.forUpdateRows = [];
    await expect(
      applyAdminWithdrawal({
        userId: 'u-new',
        currency: 'USD',
        amountMinor: 500n,
        intent,
        reason: 'r',
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('rejects zero / negative amount before touching the DB', async () => {
    await expect(
      applyAdminWithdrawal({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 0n,
        intent,
        reason: 'r',
      }),
    ).rejects.toThrow(/Withdrawal amount must be positive/);
    await expect(
      applyAdminWithdrawal({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: -100n,
        intent,
        reason: 'r',
      }),
    ).rejects.toThrow(/Withdrawal amount must be positive/);
  });

  it('A2-901 / ADR-024 §4: maps unique-violation on credit-tx to WithdrawalAlreadyIssuedError', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.returnedPayoutRow = { id: 'p-dup' };
    state.creditInsertError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'credit_transactions_reference_unique',
      detail:
        'Key (type, reference_type, reference_id)=(withdrawal, payout, p-dup) already exists.',
    });
    await expect(
      applyAdminWithdrawal({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
        reason: 'r',
      }),
    ).rejects.toBeInstanceOf(WithdrawalAlreadyIssuedError);
  });

  it('extracts the payout id from the unique-violation detail', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.returnedPayoutRow = { id: 'p-extract' };
    state.creditInsertError = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint_name: 'credit_transactions_reference_unique',
      detail:
        'Key (type, reference_type, reference_id)=(withdrawal, payout, p-extract) already exists.',
    });
    try {
      await applyAdminWithdrawal({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
        reason: 'r',
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WithdrawalAlreadyIssuedError);
      expect((err as WithdrawalAlreadyIssuedError).payoutId).toBe('p-extract');
    }
  });

  it('rethrows unrelated pg errors as-is', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.returnedPayoutRow = { id: 'p-fk' };
    state.creditInsertError = Object.assign(new Error('fk violation'), {
      code: '23503',
      constraint_name: 'credit_transactions_user_id_users_id_fk',
    });
    await expect(
      applyAdminWithdrawal({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
        reason: 'r',
      }),
    ).rejects.not.toBeInstanceOf(WithdrawalAlreadyIssuedError);
  });

  it('persists operator reason on the credit-tx row (A2-908)', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.returnedPayoutRow = { id: 'p-r' };
    state.returnedCreditRow = { id: 'ct-r', createdAt: new Date() };
    await applyAdminWithdrawal({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      intent,
      reason: 'manual cash-out per ops ticket #1234',
    });
    expect(state.insertCreditCalls[0]).toMatchObject({
      reason: 'manual cash-out per ops ticket #1234',
    });
  });
});
