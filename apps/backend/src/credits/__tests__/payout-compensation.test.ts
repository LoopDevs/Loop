import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, state } = vi.hoisted(() => {
  interface State {
    forUpdateResults: unknown[][];
    insertCreditCalls: unknown[];
    insertUserCreditsCalls: unknown[];
    updateCalls: Array<{ table: string | undefined; values: unknown }>;
    returnedCreditRow: unknown;
    /** pg_advisory_xact_lock bigint args, in call order. */
    advisoryLockCalls: bigint[];
  }
  const s: State = {
    forUpdateResults: [],
    insertCreditCalls: [],
    insertUserCreditsCalls: [],
    updateCalls: [],
    returnedCreditRow: null,
    advisoryLockCalls: [],
  };

  /** Recursively pull bigints out of drizzle's sql-template object. */
  function extractBigints(v: unknown, out: bigint[]): void {
    if (typeof v === 'bigint') {
      out.push(v);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) extractBigints(item, out);
      return;
    }
    for (const value of Object.values(v as Record<string, unknown>)) {
      extractBigints(value, out);
    }
  }

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => chain);
  chain['for'] = vi.fn(async () => s.forUpdateResults.shift() ?? []);
  // the cap check now opens with `tx.execute(SELECT
  // pg_advisory_xact_lock(...))`. Capture the bigint lock key so
  // tests can pin the key derivation.
  chain['execute'] = vi.fn(async (q: unknown) => {
    extractBigints(q, s.advisoryLockCalls);
    return [];
  });
  // A4-020: the daily-cap check runs `select().from().where()`
  // without `.for('update')` and awaits the chain directly. Make
  // the chain thenable so it resolves to an empty array (no
  // prior compensations on the day) — the cap math then sees
  // used=0, attempt < cap, and lets the test happy-path pass.
  // Tests that want to exercise the cap can override `.then` per-test.
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (
    resolve: (v: unknown) => void,
  ) => resolve([]);
  chain['insert'] = vi.fn((table: unknown) => {
    const name = (table as Record<string, unknown>)['__name'];
    (chain as unknown as { _lastInsert: string | undefined })._lastInsert =
      typeof name === 'string' ? name : undefined;
    return chain;
  });
  chain['values'] = vi.fn((values: unknown) => {
    const last = (chain as unknown as { _lastInsert: string | undefined })._lastInsert;
    if (last === 'creditTransactions') s.insertCreditCalls.push(values);
    if (last === 'userCredits') s.insertUserCreditsCalls.push(values);
    return chain;
  });
  chain['returning'] = vi.fn(async () => [s.returnedCreditRow]);
  chain['update'] = vi.fn((table: unknown) => {
    const name = (table as Record<string, unknown>)['__name'];
    (chain as unknown as { _lastUpdate: string | undefined })._lastUpdate =
      typeof name === 'string' ? name : undefined;
    return chain;
  });
  chain['set'] = vi.fn((values: unknown) => {
    s.updateCalls.push({
      table: (chain as unknown as { _lastUpdate: string | undefined })._lastUpdate,
      values,
    });
    return chain;
  });
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  creditTransactions: { __name: 'creditTransactions' },
  pendingPayouts: {
    __name: 'pendingPayouts',
    id: 'id',
    compensatedAt: 'compensated_at',
  },
  userCredits: {
    __name: 'userCredits',
    userId: 'user_id',
    currency: 'currency',
  },
}));

import { adjustmentCapLockKey, DailyAdjustmentLimitError } from '../adjustments.js';
import {
  AlreadyCompensatedError,
  applyAdminPayoutCompensation,
  PayoutNotCompensableError,
} from '../payout-compensation.js';
import { env } from '../../env.js';

beforeEach(() => {
  state.forUpdateResults = [];
  state.insertCreditCalls = [];
  state.insertUserCreditsCalls = [];
  state.updateCalls = [];
  state.returnedCreditRow = { id: 'ct-1', createdAt: new Date('2026-04-29T00:00:00Z') };
  state.advisoryLockCalls = [];
});

describe('applyAdminPayoutCompensation', () => {
  it('locks the payout, writes the adjustment, bumps balance, and marks compensatedAt', async () => {
    state.forUpdateResults = [
      [
        {
          id: 'p-1',
          // A4-022/021: primitive now asserts userId match and
          // amountMinor equals payout.amountStroops / 100_000n.
          userId: 'u-1',
          amountStroops: 50_000_000n,
          kind: 'withdrawal',
          state: 'failed',
          compensatedAt: null,
        },
      ],
      [{ userId: 'u-1', currency: 'USD', balanceMinor: 100n }],
    ];

    const result = await applyAdminPayoutCompensation({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      payoutId: 'p-1',
      reason: 'manual compensation',
    });

    expect(result).toMatchObject({
      id: 'ct-1',
      payoutId: 'p-1',
      priorBalanceMinor: 100n,
      newBalanceMinor: 600n,
    });
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'adjustment',
      amountMinor: 500n,
      referenceType: 'payout',
      referenceId: 'p-1',
      reason: 'manual compensation',
    });
    expect(state.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'userCredits',
          values: expect.objectContaining({ balanceMinor: 600n }),
        }),
        expect.objectContaining({
          table: 'pendingPayouts',
          values: expect.objectContaining({ compensatedAt: expect.anything() }),
        }),
      ]),
    );
  });

  it('throws AlreadyCompensatedError when the payout is already marked compensated', async () => {
    state.forUpdateResults = [
      [
        {
          id: 'p-1',
          kind: 'withdrawal',
          state: 'failed',
          compensatedAt: new Date('2026-04-29T00:00:00Z'),
        },
      ],
    ];

    await expect(
      applyAdminPayoutCompensation({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        payoutId: 'p-1',
        reason: 'manual compensation',
      }),
    ).rejects.toBeInstanceOf(AlreadyCompensatedError);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('throws PayoutNotCompensableError when the payout is not a failed withdrawal', async () => {
    state.forUpdateResults = [
      [
        {
          id: 'p-1',
          kind: 'order_cashback',
          state: 'failed',
          compensatedAt: null,
        },
      ],
    ];

    await expect(
      applyAdminPayoutCompensation({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        payoutId: 'p-1',
        reason: 'manual compensation',
      }),
    ).rejects.toBeInstanceOf(PayoutNotCompensableError);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('A4-022: throws when args.userId does not match the locked payout.userId', async () => {
    state.forUpdateResults = [
      [
        {
          id: 'p-1',
          userId: 'u-other',
          amountStroops: 50_000_000n,
          kind: 'withdrawal',
          state: 'failed',
          compensatedAt: null,
        },
      ],
    ];
    await expect(
      applyAdminPayoutCompensation({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        payoutId: 'p-1',
        reason: 'manual compensation',
      }),
    ).rejects.toBeInstanceOf(PayoutNotCompensableError);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('A4-021: throws when args.amountMinor does not equal payout.amountStroops / 100_000n', async () => {
    state.forUpdateResults = [
      [
        {
          id: 'p-1',
          userId: 'u-1',
          // 50_000_000 stroops = 500 minor; caller asks for 600 — mismatch.
          amountStroops: 50_000_000n,
          kind: 'withdrawal',
          state: 'failed',
          compensatedAt: null,
        },
      ],
    ];
    await expect(
      applyAdminPayoutCompensation({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 600n,
        payoutId: 'p-1',
        reason: 'manual compensation',
      }),
    ).rejects.toBeInstanceOf(PayoutNotCompensableError);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('acquires the shared cap advisory lock keyed (payout-compensation, currency, UTC day)', async () => {
    state.forUpdateResults = [
      [
        {
          id: 'p-1',
          userId: 'u-1',
          amountStroops: 50_000_000n,
          kind: 'withdrawal',
          state: 'failed',
          compensatedAt: null,
        },
      ],
      [{ userId: 'u-1', currency: 'USD', balanceMinor: 100n }],
    ];

    await applyAdminPayoutCompensation({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      payoutId: 'p-1',
      reason: 'manual compensation',
    });

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    // Exact same derivation `applyAdminCreditAdjustment` uses, with
    // the fleet-wide 'payout-compensation' scope in place of an
    // admin id — every concurrent compensation in the same
    // (currency, day) bucket serialises on this one lock.
    expect(state.advisoryLockCalls).toEqual([
      adjustmentCapLockKey('payout-compensation', 'USD', dayStart),
    ]);
  });

  it('throws DailyAdjustmentLimitError when the day total would exceed the cap', async () => {
    const previousCap = env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR;
    env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = 700n;
    const chain = dbMock as unknown as { then: (resolve: (v: unknown) => void) => void };
    const previousThen = chain.then;
    // Cap read sees 500 minor already compensated today; the next
    // 500 would take the bucket to 1000 > 700.
    chain.then = (resolve: (v: unknown) => void) => resolve([{ usedMinor: '500' }]);
    try {
      state.forUpdateResults = [
        [
          {
            id: 'p-2',
            userId: 'u-1',
            amountStroops: 50_000_000n,
            kind: 'withdrawal',
            state: 'failed',
            compensatedAt: null,
          },
        ],
      ];
      await expect(
        applyAdminPayoutCompensation({
          userId: 'u-1',
          currency: 'USD',
          amountMinor: 500n,
          payoutId: 'p-2',
          reason: 'manual compensation',
        }),
      ).rejects.toBeInstanceOf(DailyAdjustmentLimitError);
      // The lock was still taken (check happens under it) and no
      // ledger write landed.
      expect(state.advisoryLockCalls).toHaveLength(1);
      expect(state.insertCreditCalls).toHaveLength(0);
    } finally {
      chain.then = previousThen;
      env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR = previousCap;
    }
  });
});
