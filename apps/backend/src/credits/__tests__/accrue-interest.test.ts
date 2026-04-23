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
    /**
     * The outer planning select (in `accrueOnePeriod`) reads
     * `{userId, currency}`. The inner per-user txn select reads
     * `{balanceMinor}` under `FOR UPDATE`. Both resolve against
     * `state.rows` — callers set the full row shape (with
     * `balanceMinor`) and the code picks the fields it needs.
     */
    rows: unknown[];
    inserts: unknown[];
    updateSets: unknown[];
    txThrowNext: boolean;
    /** Throw a unique-violation on next insert — for the idempotency test. */
    insertThrowUniqueNext: boolean;
  } = {
    rows: [],
    inserts: [],
    updateSets: [],
    txThrowNext: false,
    insertThrowUniqueNext: false,
  };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  // `where(...)` returns a Thenable that is awaitable (the outer
  // planning select awaits it and gets the full `state.rows`) AND
  // chainable via `.for('update')` — the inner txn select. The FOR
  // UPDATE path returns a single-element array of the row whose
  // index matches how many FOR UPDATE calls have happened, so
  // successive per-user txns see their own row's balance rather than
  // all txns reading `rows[0]`.
  //
  // This makes A2-610 detectable in the mock: the inserted amounts
  // per user reflect that user's balance, not the whole batch's.
  let forUpdateCursor = 0;
  m['where'] = vi.fn(() => {
    const thenable: {
      then: (resolve: (v: unknown) => unknown) => unknown;
      for: ReturnType<typeof vi.fn>;
    } = {
      then: (resolve) => resolve(s.rows),
      for: vi.fn(async () => {
        const row = s.rows[forUpdateCursor];
        forUpdateCursor++;
        return row === undefined ? [] : [row];
      }),
    };
    return thenable;
  });
  // Exposed so beforeEach can reset the FOR UPDATE cursor.
  (m as unknown as { __resetForUpdateCursor: () => void }).__resetForUpdateCursor = () => {
    forUpdateCursor = 0;
  };
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn(async (v: unknown) => {
    if (s.insertThrowUniqueNext) {
      s.insertThrowUniqueNext = false;
      const err = new Error(
        'duplicate key value violates unique constraint "credit_transactions_interest_period_unique"',
      );
      throw err;
    }
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

const CURSOR = '2026-04-23';

beforeEach(() => {
  state.rows = [];
  state.inserts = [];
  state.updateSets = [];
  state.txThrowNext = false;
  state.insertThrowUniqueNext = false;
  (dbMock as unknown as { __resetForUpdateCursor: () => void }).__resetForUpdateCursor();
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
    const r = await accrueOnePeriod({ apyBasisPoints: 0, periodsPerYear: 12 }, CURSOR);
    expect(r).toEqual({
      users: 0,
      credited: 0,
      skippedZero: 0,
      skippedAlreadyAccrued: 0,
      totalsMinor: {},
    });
    expect(state.inserts).toHaveLength(0);
  });

  it('throws on empty periodCursor — caller must supply an identifier', async () => {
    await expect(accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, '')).rejects.toThrow(
      /periodCursor/,
    );
  });

  it('writes a credit_transactions row (carrying periodCursor) + bumps user_credits per user', async () => {
    state.rows = [
      { userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n },
      { userId: 'u-2', currency: 'USD', balanceMinor: 50_000n },
    ];
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, CURSOR);
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
      periodCursor: CURSOR,
    });
    expect(state.inserts[1]).toMatchObject({
      userId: 'u-2',
      type: 'interest',
      amountMinor: 166n,
      currency: 'USD',
      periodCursor: CURSOR,
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
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, CURSOR);
    expect(r.totalsMinor['GBP']).toBe(333n + 666n);
    expect(r.totalsMinor['USD']).toBe(166n);
  });

  it('skips zero-accrual balances (tiny balance, CHECK amount>0)', async () => {
    state.rows = [{ userId: 'u-1', currency: 'GBP', balanceMinor: 10n }];
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, CURSOR);
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
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, CURSOR);
    expect(r.users).toBe(2);
    expect(r.credited).toBe(1);
  });

  it('A2-906: unique-index violation is caught and counted as skippedAlreadyAccrued', async () => {
    state.rows = [
      { userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n },
      { userId: 'u-2', currency: 'USD', balanceMinor: 50_000n },
    ];
    state.insertThrowUniqueNext = true; // first insert hits the period-unique constraint
    const r = await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, CURSOR);
    // u-1's insert throws unique-violation → skipped; u-2 credits normally.
    expect(r.credited).toBe(1);
    expect(r.skippedAlreadyAccrued).toBe(1);
    expect(state.inserts).toHaveLength(1); // only u-2's insert made it through
  });

  it('uses a transaction for each per-user write', async () => {
    state.rows = [{ userId: 'u-1', currency: 'GBP', balanceMinor: 100_000n }];
    await accrueOnePeriod({ apyBasisPoints: 400, periodsPerYear: 12 }, CURSOR);
    expect(dbMock['transaction']!).toHaveBeenCalled();
  });
});
