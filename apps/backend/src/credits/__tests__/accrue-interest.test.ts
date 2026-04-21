import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Chainable db mock:
 *   - `select().from().where()` → stashed user_credits rows
 *   - `insert()` + `update()` inside a tx → capture inserted + updated rows
 *   - `transaction(cb)` → cb(db) so all writes land on the outer mock
 */
const { dbMock, state } = vi.hoisted(() => {
  const s: {
    rows: unknown[];
    inserts: unknown[];
    updateSets: unknown[];
    txThrowNext: boolean;
  } = { rows: [], inserts: [], updateSets: [], txThrowNext: false };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  m['where'] = vi.fn(async () => s.rows);
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn((v: unknown) => {
    s.inserts.push(v);
    return m;
  });
  m['update'] = vi.fn(() => m);
  m['set'] = vi.fn((v: unknown) => {
    s.updateSets.push(v);
    return m;
  });
  m['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    if (s.txThrowNext) {
      s.txThrowNext = false;
      throw new Error('tx boom');
    }
    return cb(m);
  });
  return { dbMock: m, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    creditTransactions: {
      userId: 'user_id',
      type: 'type',
      amountMinor: 'amount_minor',
      currency: 'currency',
      referenceType: 'reference_type',
      referenceId: 'reference_id',
    },
    userCredits: {
      userId: 'user_id',
      currency: 'currency',
      balanceMinor: 'balance_minor',
    },
  };
});

import { accrueOnePeriod, computeAccrualMinor } from '../accrue-interest.js';

beforeEach(() => {
  state.rows = [];
  state.inserts = [];
  state.updateSets = [];
  state.txThrowNext = false;
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('computeAccrualMinor', () => {
  it('floors (balance × bps) / (10_000 × periodsPerYear)', () => {
    // £1000.00 balance = 100_000 pence. 400 bps / 12 periods.
    // expected = (100_000 × 400) / (10_000 × 12) = 40_000_000 / 120_000 = 333
    expect(computeAccrualMinor(100_000n, { apyBasisPoints: 400, periodsPerYear: 12 })).toBe(333n);
  });

  it('daily accrual for the same balance', () => {
    // 100_000 × 400 / (10_000 × 365) = 40_000_000 / 3_650_000 = 10.958… → 10
    expect(computeAccrualMinor(100_000n, { apyBasisPoints: 400, periodsPerYear: 365 })).toBe(10n);
  });

  it('returns 0 for zero or negative balance', () => {
    expect(computeAccrualMinor(0n, { apyBasisPoints: 400, periodsPerYear: 12 })).toBe(0n);
    expect(computeAccrualMinor(-1n, { apyBasisPoints: 400, periodsPerYear: 12 })).toBe(0n);
  });

  it('returns 0 for zero or negative APY', () => {
    expect(computeAccrualMinor(100_000n, { apyBasisPoints: 0, periodsPerYear: 12 })).toBe(0n);
    expect(computeAccrualMinor(100_000n, { apyBasisPoints: -400, periodsPerYear: 12 })).toBe(0n);
  });

  it('returns 0 for zero periodsPerYear (operator bug)', () => {
    expect(computeAccrualMinor(100_000n, { apyBasisPoints: 400, periodsPerYear: 0 })).toBe(0n);
  });

  it('floors any tiny balance × small accrual', () => {
    // 50 pence × 400 bps / (10_000 × 12) = 20_000 / 120_000 = 0.1666 → 0
    expect(computeAccrualMinor(50n, { apyBasisPoints: 400, periodsPerYear: 12 })).toBe(0n);
  });
});

describe('accrueOnePeriod', () => {
  it('returns all-zero and does no writes when APY is 0', async () => {
    state.rows = [{ userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n }];
    const r = await accrueOnePeriod({ apyBasisPoints: 0, periodsPerYear: 12 });
    expect(r).toEqual({ users: 0, credited: 0, skippedZero: 0, totalsMinor: {} });
    expect(state.inserts).toHaveLength(0);
  });

  it('writes a credit_transactions row + bumps user_credits per user', async () => {
    state.rows = [
      { userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n },
      { userId: 'u-2', currency: 'USD', balanceMinor: 50_000n },
    ];
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 });
    expect(r.users).toBe(2);
    expect(r.credited).toBe(2);
    expect(state.inserts).toHaveLength(2);
    expect(state.inserts[0]).toMatchObject({
      userId: 'u-1',
      type: 'interest',
      amountMinor: 333n,
      currency: 'GBP',
      referenceType: null,
      referenceId: null,
    });
    expect(state.inserts[1]).toMatchObject({
      userId: 'u-2',
      type: 'interest',
      amountMinor: 166n,
      currency: 'USD',
    });
    expect(state.updateSets).toHaveLength(2);
    expect(state.updateSets[0]).toMatchObject({ balanceMinor: 100_333n });
    expect(state.updateSets[1]).toMatchObject({ balanceMinor: 50_166n });
  });

  it('increments totalsMinor per currency', async () => {
    state.rows = [
      { userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n },
      { userId: 'u-2', currency: 'GBP', balanceMinor: 200_000n },
      { userId: 'u-3', currency: 'USD', balanceMinor: 50_000n },
    ];
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 });
    expect(r.totalsMinor['GBP']).toBe(333n + 666n);
    expect(r.totalsMinor['USD']).toBe(166n);
  });

  it('skips zero-accrual balances (tiny balance, CHECK amount>0)', async () => {
    state.rows = [{ userId: 'u-1', currency: 'GBP', balanceMinor: 10n }];
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 });
    expect(r.users).toBe(1);
    expect(r.credited).toBe(0);
    expect(r.skippedZero).toBe(1);
    expect(state.inserts).toHaveLength(0);
  });

  it('a single-user txn failure does not abort the whole batch', async () => {
    state.rows = [
      { userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n },
      { userId: 'u-2', currency: 'USD', balanceMinor: 50_000n },
    ];
    state.txThrowNext = true; // first txn throws; second should still run
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 });
    // u-1 throws, u-2 succeeds.
    expect(r.users).toBe(2);
    expect(r.credited).toBe(1);
  });

  it('uses a transaction for each per-user write', async () => {
    state.rows = [{ userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n }];
    await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 });
    expect(dbMock['transaction']!).toHaveBeenCalled();
  });
});
