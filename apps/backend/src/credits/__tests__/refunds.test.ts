import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors the credit-adjustments repo test pattern (chainable-db
 * mock). `applyAdminRefund` issues up to three selects inside the txn,
 * in order:
 *
 *   1. The CF-06 order row (`FOR UPDATE` on `orders`) — validates
 *      existence / ownership / currency / over-refund.
 *   2. The CF-06 daily-cap sum (`ABS(amount_minor)` for today's
 *      refunds; only when the cap is enabled) — terminates with the
 *      awaited `.where(...)`, no `.for('update')`.
 *   3. The `FOR UPDATE` read of the `user_credits` balance row.
 *
 * The mock serves these in FIFO order from `forUpdateResponses`: a
 * test stages the order row first, then (if the cap is on) the cap
 * sum, then the balance row. The `.where(...)` thenable resolves the
 * next queued response AND is chainable to `.for('update')` so both
 * the awaited cap-sum query and the `.for('update')` lock reads pull
 * from the same queue.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    /** FIFO queue served by `.for('update')` and awaited `.where(...)`. */
    forUpdateResponses: unknown[];
    insertCreditCalls: unknown[];
    insertUserCreditsCalls: unknown[];
    insertSkipCalls: unknown[];
    updateSets: unknown[];
    returnedCreditRow: unknown;
    // Error to throw from the credit_transactions insert .returning() —
    // simulates a DB unique-violation for the duplicate-refund case.
    creditInsertError: Error | null;
  }
  const s: State = {
    forUpdateResponses: [],
    insertCreditCalls: [],
    insertUserCreditsCalls: [],
    insertSkipCalls: [],
    updateSets: [],
    returnedCreditRow: null,
    creditInsertError: null,
  };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['execute'] = vi.fn(async () => []);
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
    else if (last === 'paymentWatcherSkips') s.insertSkipCalls.push(v);
    return chain;
  });
  chain['onConflictDoUpdate'] = vi.fn(() => chain);
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
  creditTransactions: {
    __name: 'creditTransactions',
    type: 'type',
    currency: 'currency',
    createdAt: 'created_at',
    amountMinor: 'amount_minor',
  },
  orders: { __name: 'orders', id: 'id' },
  paymentWatcherSkips: {
    __name: 'paymentWatcherSkips',
    paymentId: 'payment_id',
    status: 'status',
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

const { refundDepositMock } = vi.hoisted(() => ({
  refundDepositMock: vi.fn(),
}));
vi.mock('../../payments/deposit-refund.js', () => ({
  refundDeposit: (paymentId: string) => refundDepositMock(paymentId),
}));
vi.mock('../../payments/horizon.js', () => ({
  HorizonPaymentSchema: {
    safeParse: (value: unknown) =>
      typeof (value as { id?: unknown } | null)?.id === 'string'
        ? { success: true, data: value }
        : { success: false, error: { issues: [] } },
  },
}));

import {
  applyAdminRefund,
  applyOrderAutoRefund,
  AUTO_REFUND_SYSTEM_ACTOR,
  RefundAlreadyIssuedError,
  RefundOrderInvalidError,
} from '../refunds.js';
import { DailyAdjustmentLimitError } from '../adjustments.js';

/** A matching order row the validation accepts (USD, charge 5000). */
function okOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderUserId: 'u-1',
    chargeMinor: 5000n,
    chargeCurrency: 'USD',
    ...overrides,
  };
}

beforeEach(() => {
  state.forUpdateResponses = [];
  state.insertCreditCalls = [];
  state.insertUserCreditsCalls = [];
  state.insertSkipCalls = [];
  state.updateSets = [];
  state.returnedCreditRow = null;
  state.creditInsertError = null;
  refundDepositMock.mockReset();
  refundDepositMock.mockResolvedValue({ kind: 'refunded', txHash: 'refund-tx' });
  envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 0n;
});

describe('applyAdminRefund', () => {
  it('happy path: inserts refund row + creates balance row when user has no prior balance', async () => {
    // [order row, user_credits row] (cap disabled → no cap query).
    state.forUpdateResponses = [[okOrder()], []];
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
    state.forUpdateResponses = [
      [okOrder()],
      [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }],
    ];
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
    state.forUpdateResponses = [[okOrder()], []];
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

  // A2-908: reason passes through to the ledger insert so ops can
  // reconstruct the "why" past the 24h idempotency-key TTL sweep.
  it('A2-908: persists operator reason on the credit_transactions row', async () => {
    state.forUpdateResponses = [[okOrder()], []];
    state.returnedCreditRow = { id: 'ct-reason', createdAt: new Date() };
    await applyAdminRefund({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      orderId: 'o-1',
      adminUserId: 'admin-1',
      reason: 'merchant shipped wrong denomination',
    });
    expect(state.insertCreditCalls[0]).toMatchObject({
      reason: 'merchant shipped wrong denomination',
    });
  });

  it('A2-908: omits reason field when caller provides none (backwards compat)', async () => {
    state.forUpdateResponses = [[okOrder()], []];
    state.returnedCreditRow = { id: 'ct-no-reason', createdAt: new Date() };
    await applyAdminRefund({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      orderId: 'o-1',
      adminUserId: 'admin-1',
    });
    expect(state.insertCreditCalls[0]).not.toHaveProperty('reason');
  });

  it('rethrows unrelated pg errors', async () => {
    state.forUpdateResponses = [[okOrder()], []];
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

  describe('CF-06 order validation', () => {
    it('rejects a refund against an order that does not exist (order_not_found)', async () => {
      state.forUpdateResponses = [[]]; // no order row
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 500n,
          orderId: 'o-missing',
          adminUserId: 'admin-1',
        }),
      ).rejects.toMatchObject({ name: 'RefundOrderInvalidError', reason: 'order_not_found' });
      // Nothing was written.
      expect(state.insertCreditCalls).toHaveLength(0);
      expect(state.insertUserCreditsCalls).toHaveLength(0);
    });

    it('rejects a refund against an order owned by a different user (IDOR)', async () => {
      state.forUpdateResponses = [[okOrder({ orderUserId: 'someone-else' })]];
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 500n,
          orderId: 'o-1',
          adminUserId: 'admin-1',
        }),
      ).rejects.toMatchObject({
        name: 'RefundOrderInvalidError',
        reason: 'order_user_mismatch',
      });
      expect(state.insertCreditCalls).toHaveLength(0);
    });

    it('rejects a refund whose currency differs from the order charge currency', async () => {
      state.forUpdateResponses = [[okOrder({ chargeCurrency: 'GBP' })]];
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 500n,
          orderId: 'o-1',
          adminUserId: 'admin-1',
        }),
      ).rejects.toMatchObject({ name: 'RefundOrderInvalidError', reason: 'currency_mismatch' });
      expect(state.insertCreditCalls).toHaveLength(0);
    });

    it('rejects an over-refund (amount exceeds the order charge)', async () => {
      state.forUpdateResponses = [[okOrder({ chargeMinor: 5000n })]];
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 5001n,
          orderId: 'o-1',
          adminUserId: 'admin-1',
        }),
      ).rejects.toMatchObject({ name: 'RefundOrderInvalidError', reason: 'exceeds_charge' });
      expect(state.insertCreditCalls).toHaveLength(0);
    });

    it('allows a refund exactly equal to the order charge', async () => {
      state.forUpdateResponses = [[okOrder({ chargeMinor: 5000n })], []];
      state.returnedCreditRow = { id: 'ct-eq', createdAt: new Date() };
      const result = await applyAdminRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 5000n,
        orderId: 'o-1',
        adminUserId: 'admin-1',
      });
      expect(result.amountMinor).toBe(5000n);
      expect(state.insertCreditCalls).toHaveLength(1);
    });

    it('RefundOrderInvalidError is the exported class', async () => {
      state.forUpdateResponses = [[]];
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 1n,
          orderId: 'o-missing',
          adminUserId: 'admin-1',
        }),
      ).rejects.toBeInstanceOf(RefundOrderInvalidError);
    });
  });

  describe('CF-06 daily refund cap', () => {
    it('skips the cap check when the cap is 0 (disabled)', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 0n;
      // Only [order, balance] — no cap query is issued.
      state.forUpdateResponses = [[okOrder({ chargeMinor: 10_000_000n })], []];
      state.returnedCreditRow = { id: 'ct-nocap', createdAt: new Date() };
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 9_000_000n,
          orderId: 'o-1',
          adminUserId: 'admin-1',
        }),
      ).resolves.toBeDefined();
    });

    it('allows a refund when today-refunds + amount stays under the cap', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1_000_000n;
      // [order, cap-sum(used=400000), balance]
      state.forUpdateResponses = [
        [okOrder({ chargeMinor: 1_000_000n })],
        [{ usedMinor: '400000' }],
        [],
      ];
      state.returnedCreditRow = { id: 'ct-undercap', createdAt: new Date() };
      const result = await applyAdminRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500_000n,
        orderId: 'o-1',
        adminUserId: 'admin-1',
      });
      expect(result.newBalanceMinor).toBe(500_000n);
      // The cap path took the advisory lock.
      expect(dbMock['execute']!).toHaveBeenCalledOnce();
    });

    it('rejects with DailyAdjustmentLimitError when today-refunds + amount exceeds the cap', async () => {
      envMock.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 1_000_000n;
      // [order, cap-sum(used=900000)] — the cap throw happens before
      // the balance read, so no balance row is queued.
      state.forUpdateResponses = [
        [okOrder({ chargeMinor: 1_000_000n })],
        [{ usedMinor: '900000' }],
      ];
      await expect(
        applyAdminRefund({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 200_000n,
          orderId: 'o-1',
          adminUserId: 'admin-1',
        }),
      ).rejects.toThrow(DailyAdjustmentLimitError);
      expect(state.insertCreditCalls).toHaveLength(0);
      expect(state.insertUserCreditsCalls).toHaveLength(0);
    });
  });
});

describe('applyOrderAutoRefund (CF-20)', () => {
  it('delegates to applyAdminRefund with the system actor + reason prefix', async () => {
    state.forUpdateResponses = [[okOrder()], []];
    state.returnedCreditRow = { id: 'ct-auto', createdAt: new Date('2026-06-15') };
    const result = await applyOrderAutoRefund({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      orderId: 'o-1',
      reason: 'order failed after CTX paid: timeout',
    });
    expect('kind' in result).toBe(false);
    if ('kind' in result) throw new Error('expected ledger refund result');
    expect(result.amountMinor).toBe(500n);
    // Same validated refund row shape as the admin path — positive,
    // type='refund', order-scoped.
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'refund',
      amountMinor: 500n,
      currency: 'USD',
      referenceType: 'order',
      referenceId: 'o-1',
    });
    // The reason carries the greppable system-actor prefix so an auto
    // refund is distinguishable from an operator-issued one on the row.
    expect((state.insertCreditCalls[0] as { reason: string }).reason).toContain(
      AUTO_REFUND_SYSTEM_ACTOR,
    );
    expect((state.insertCreditCalls[0] as { reason: string }).reason).toContain(
      'order failed after CTX paid: timeout',
    );
  });

  it('over-refund / wrong-currency fences still apply (it is the admin primitive underneath)', async () => {
    // Order charged 5000 USD; an auto-refund for 9000 must be rejected
    // by the same over-refund fence applyAdminRefund enforces.
    state.forUpdateResponses = [[okOrder({ chargeMinor: 5000n })]];
    await expect(
      applyOrderAutoRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 9000n,
        orderId: 'o-1',
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(RefundOrderInvalidError);
  });

  it('R3-2: xlm/usdc payments are refunded to the original on-chain sender, not internal credit', async () => {
    const payment = {
      id: 'pay-1',
      paging_token: 'pt-1',
      type: 'payment',
      from: 'GSENDER',
      to: 'GDEPOSIT',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GISSUER',
      amount: '10.0000000',
      transaction_hash: 'tx-in',
      transaction: { memo: 'MEMO-1', memo_type: 'text', successful: true },
    };

    const result = await applyOrderAutoRefund({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 1000n,
      orderId: 'o-usdc',
      paymentMethod: 'usdc',
      paymentMemo: 'MEMO-1',
      paymentReceivedHorizonId: 'pay-1',
      paymentReceivedPayment: payment,
      reason: 'order failed after CTX paid: timeout',
    });

    expect(result).toEqual({
      kind: 'onchain_refund',
      orderId: 'o-usdc',
      paymentId: 'pay-1',
      refund: { kind: 'refunded', txHash: 'refund-tx' },
    });
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.insertUserCreditsCalls).toHaveLength(0);
    expect(state.insertSkipCalls[0]).toMatchObject({
      paymentId: 'pay-1',
      memo: 'MEMO-1',
      orderId: 'o-usdc',
      reason: 'order_gone',
      payment,
      status: 'abandoned',
    });
    expect(refundDepositMock).toHaveBeenCalledWith('pay-1');
  });

  it('R3-2: xlm/usdc auto-refund fails closed when the outbound refund does not complete', async () => {
    refundDepositMock.mockResolvedValue({ kind: 'in_progress' });
    const payment = {
      id: 'pay-2',
      paging_token: 'pt-2',
      type: 'payment',
      from: 'GSENDER',
      to: 'GDEPOSIT',
      asset_type: 'native',
      amount: '2.0000000',
      transaction_hash: 'tx-in-2',
      transaction: { memo: 'MEMO-2', memo_type: 'text', successful: true },
    };

    await expect(
      applyOrderAutoRefund({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 200n,
        orderId: 'o-xlm',
        paymentMethod: 'xlm',
        paymentMemo: 'MEMO-2',
        paymentReceivedHorizonId: 'pay-2',
        paymentReceivedPayment: payment,
        reason: 'order failed before CTX paid: schema drift',
      }),
    ).rejects.toThrow(/did not complete: in_progress/);
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.insertSkipCalls[0]).toMatchObject({ paymentId: 'pay-2', status: 'abandoned' });
  });

  it('R3-2: loop_asset auto-refund is guarded until re-mint + mirror semantics are implemented', async () => {
    await expect(
      applyOrderAutoRefund({
        userId: 'u-1',
        currency: 'GBP',
        amountMinor: 500n,
        orderId: 'o-loop',
        paymentMethod: 'loop_asset',
        reason: 'x',
      }),
    ).rejects.toThrow(/loop_asset order auto-refund requires coordinated mirror re-credit/);
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(refundDepositMock).not.toHaveBeenCalled();
  });
});
