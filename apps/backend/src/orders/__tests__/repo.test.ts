import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

// Mock the env module so per-test overrides of
// DEFAULT_USER_CASHBACK_PCT_OF_CTX / DEFAULT_LOOP_MARGIN_PCT_OF_CTX
// drive `fallbackSplit()` (A2-203). Proxy handler falls back to the
// real env for every other key so the rest of the repo surface (db
// URL, feature flags, etc.) keeps working.
const { envOverrides } = vi.hoisted(() => ({
  envOverrides: {} as Record<string, string | undefined>,
}));
vi.mock('../../env.js', async () => {
  const actual = (await vi.importActual('../../env.js')) as { env: Record<string, unknown> };
  return {
    env: new Proxy(
      {},
      {
        get(_, key: string) {
          if (key in envOverrides) return envOverrides[key];
          return actual.env[key];
        },
      },
    ),
  };
});

const { dbMock, state } = vi.hoisted(() => {
  const s: {
    config: unknown;
    insertedRow: Record<string, unknown> | null | undefined;
    /**
     * Capture of every `.values(...)` call across inserts. For
     * credit-order tests this collects both the `orders` row and the
     * subsequent `credit_transactions` row; tests inspect by index.
     */
    insertValues: unknown[];
    /** Capture of every `.set(...)` call across updates (balance + state). */
    updateSets: unknown[];
    /** The row the inner FOR UPDATE select returns (credit-order path). */
    creditBalanceRow: unknown;
    /** The row `update(orders).set(...).returning()` returns for the paid transition. */
    paidRow: unknown;
    orderByMemo: unknown;
  } = {
    config: undefined,
    insertedRow: null,
    insertValues: [],
    updateSets: [],
    creditBalanceRow: { balanceMinor: 10_000n },
    paidRow: null,
    orderByMemo: undefined,
  };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn((v: unknown) => {
    s.insertValues.push(v);
    return m;
  });
  m['returning'] = vi.fn(async () => {
    // Called by both the order insert AND the `update(orders).set().returning()`
    // paid-transition in the credit path. The first call hits the insert,
    // the second the transition. Track with a simple per-run counter.
    returningCallIndex++;
    if (returningCallIndex === 1) return [s.insertedRow];
    return [s.paidRow ?? s.insertedRow];
  });
  m['update'] = vi.fn(() => m);
  m['set'] = vi.fn((v: unknown) => {
    s.updateSets.push(v);
    return m;
  });
  m['select'] = vi.fn(() => m);
  m['from'] = vi.fn(() => m);
  // For the credit-path inner select: `.where(...).for('update')` resolves
  // to `[creditBalanceRow]`.
  m['where'] = vi.fn(() => {
    const thenable: {
      then: (resolve: (v: unknown) => unknown) => unknown;
      for: ReturnType<typeof vi.fn>;
      returning: ReturnType<typeof vi.fn>;
    } = {
      then: (resolve) => resolve([]),
      for: vi.fn(async () => [s.creditBalanceRow]),
      // `update(...).set(...).where(...).returning()` path — same
      // cursor-indexed return as the insert's returning().
      returning: vi.fn(async () => {
        returningCallIndex++;
        if (returningCallIndex === 1) return [s.insertedRow];
        return [s.paidRow ?? s.insertedRow];
      }),
    };
    return thenable;
  });
  m['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(m));
  let returningCallIndex = 0;
  // Reset cursor when callers clear state.
  (m as unknown as { __resetReturningCursor: () => void }).__resetReturningCursor = () => {
    returningCallIndex = 0;
  };
  return { dbMock: m, state: s };
});

vi.mock('../../db/client.js', () => ({
  db: {
    insert: dbMock['insert'],
    update: dbMock['update'],
    select: dbMock['select'],
    transaction: dbMock['transaction'],
    query: {
      merchantCashbackConfigs: {
        findFirst: vi.fn(async () => state.config),
      },
      orders: {
        findFirst: vi.fn(async () => state.orderByMemo),
      },
    },
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    orders: {
      id: 'id',
      userId: 'userId',
      merchantId: 'merchantId',
      faceValueMinor: 'faceValueMinor',
      currency: 'currency',
      paymentMethod: 'paymentMethod',
      paymentMemo: 'paymentMemo',
      state: 'state',
    },
    merchantCashbackConfigs: {
      merchantId: 'merchantId',
    },
    userCredits: {
      userId: 'userId',
      currency: 'currency',
      balanceMinor: 'balanceMinor',
    },
    creditTransactions: {
      userId: 'userId',
      type: 'type',
      amountMinor: 'amountMinor',
      currency: 'currency',
      referenceType: 'referenceType',
      referenceId: 'referenceId',
    },
  };
});

import {
  computeCashbackSplit,
  createOrder,
  findOrderByIdempotencyKey,
  findPendingOrderByMemo,
  generatePaymentMemo,
  IdempotentOrderConflictError,
} from '../repo.js';

beforeEach(() => {
  state.config = undefined;
  state.insertedRow = null;
  state.insertValues = [];
  state.updateSets = [];
  state.creditBalanceRow = { balanceMinor: 10_000n };
  state.paidRow = null;
  state.orderByMemo = undefined;
  for (const k of Object.keys(envOverrides)) delete envOverrides[k];
  (dbMock as unknown as { __resetReturningCursor: () => void }).__resetReturningCursor();
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('computeCashbackSplit', () => {
  it('falls back to 100% wholesale / 0% cashback / 0% margin when no config exists', async () => {
    const split = await computeCashbackSplit({
      merchantId: 'no-config',
      faceValueMinor: 10_000n,
    });
    expect(split.wholesaleMinor).toBe(10_000n);
    expect(split.userCashbackMinor).toBe(0n);
    expect(split.loopMarginMinor).toBe(0n);
    expect(split.wholesalePct).toBe('100.00');
  });

  // A2-203: admin-set defaults drive the fallback split, not a
  // hard-coded zero. A newly-synced merchant without a row earns
  // whatever DEFAULT_USER_CASHBACK_PCT_OF_CTX says.
  it('A2-203: honours env defaults when merchant has no config row', async () => {
    envOverrides['DEFAULT_USER_CASHBACK_PCT_OF_CTX'] = '8.00';
    envOverrides['DEFAULT_LOOP_MARGIN_PCT_OF_CTX'] = '2.00';
    const split = await computeCashbackSplit({
      merchantId: 'fresh-catalog-merchant',
      faceValueMinor: 10_000n,
    });
    expect(split.userCashbackMinor).toBe(800n); // 8%
    expect(split.loopMarginMinor).toBe(200n); // 2%
    expect(split.wholesaleMinor).toBe(9_000n); // residual
    expect(split.userCashbackPct).toBe('8.00');
    expect(split.loopMarginPct).toBe('2.00');
    expect(split.wholesalePct).toBe('90.00');
  });

  it('falls back to the zero split when config.active = false', async () => {
    state.config = {
      merchantId: 'paused',
      wholesalePct: '80.00',
      userCashbackPct: '15.00',
      loopMarginPct: '5.00',
      active: false,
    };
    const split = await computeCashbackSplit({
      merchantId: 'paused',
      faceValueMinor: 10_000n,
    });
    expect(split.wholesaleMinor).toBe(10_000n);
    expect(split.userCashbackMinor).toBe(0n);
    expect(split.loopMarginMinor).toBe(0n);
  });

  it('splits according to the active config pcts', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '85.00',
      userCashbackPct: '10.00',
      loopMarginPct: '5.00',
      active: true,
    };
    // face = £100.00 = 10,000 pence
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 10_000n,
    });
    expect(split.userCashbackMinor).toBe(1_000n); // 10%
    expect(split.loopMarginMinor).toBe(500n); // 5%
    expect(split.wholesaleMinor).toBe(8_500n); // residual
    expect(split.wholesaleMinor + split.userCashbackMinor + split.loopMarginMinor).toBe(10_000n);
  });

  it('handles fractional pcts (7.50% cashback on £100.00 → 750p)', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '90.00',
      userCashbackPct: '7.50',
      loopMarginPct: '2.50',
      active: true,
    };
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 10_000n,
    });
    expect(split.userCashbackMinor).toBe(750n);
    expect(split.loopMarginMinor).toBe(250n);
    expect(split.wholesaleMinor).toBe(9_000n);
  });

  it('floors user cashback (rounding residual goes to wholesale, never to the user)', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '90.00',
      userCashbackPct: '7.33',
      loopMarginPct: '2.67',
      active: true,
    };
    // 7.33% of 999p = 73.23p → floor to 73p
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 999n,
    });
    expect(split.userCashbackMinor).toBe(73n);
    // 2.67% of 999p = 26.67p → floor to 26p
    expect(split.loopMarginMinor).toBe(26n);
    // wholesale picks up the residual
    expect(split.wholesaleMinor).toBe(999n - 73n - 26n);
    // total reconciles to face value
    expect(split.wholesaleMinor + split.userCashbackMinor + split.loopMarginMinor).toBe(999n);
  });

  it('passes the merchant pcts through verbatim onto the order row', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '72.50',
      userCashbackPct: '22.50',
      loopMarginPct: '5.00',
      active: true,
    };
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 10_000n,
    });
    expect(split.wholesalePct).toBe('72.50');
    expect(split.userCashbackPct).toBe('22.50');
    expect(split.loopMarginPct).toBe('5.00');
  });
});

describe('generatePaymentMemo', () => {
  it('emits a 20-char base32 string', () => {
    for (let i = 0; i < 50; i++) {
      const m = generatePaymentMemo();
      expect(m).toMatch(/^[A-Z2-7]{20}$/);
    }
  });

  it('is (practically) unique across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generatePaymentMemo());
    // 100 bits of entropy — collision across 200 is effectively impossible.
    expect(seen.size).toBe(200);
  });
});

describe('createOrder', () => {
  beforeEach(() => {
    state.insertedRow = {
      id: 'order-uuid',
      userId: 'u-1',
      merchantId: 'm1',
      state: 'pending_payment',
    };
    state.config = {
      merchantId: 'm1',
      wholesalePct: '85.00',
      userCashbackPct: '10.00',
      loopMarginPct: '5.00',
      active: true,
    };
  });

  it('inserts with the pinned pcts + amounts from the active config', async () => {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'xlm',
    });
    expect(row.id).toBe('order-uuid');
    const values = state.insertValues[0] as Record<string, unknown>;
    expect(values['userId']).toBe('u-1');
    expect(values['merchantId']).toBe('m1');
    expect(values['faceValueMinor']).toBe(10_000n);
    expect(values['currency']).toBe('GBP');
    expect(values['paymentMethod']).toBe('xlm');
    expect(values['wholesalePct']).toBe('85.00');
    expect(values['userCashbackPct']).toBe('10.00');
    expect(values['loopMarginPct']).toBe('5.00');
    expect(values['wholesaleMinor']).toBe(8_500n);
    expect(values['userCashbackMinor']).toBe(1_000n);
    expect(values['loopMarginMinor']).toBe(500n);
    // xlm / usdc orders get a generated memo
    expect(typeof values['paymentMemo']).toBe('string');
    expect((values['paymentMemo'] as string).length).toBe(20);
  });

  it('leaves payment_memo null for credit-funded orders', async () => {
    // A2-601 fix: credit orders now do insert + debit + paid
    // transition in one txn. Seed enough balance and a paid-row to
    // return so the flow completes.
    state.insertedRow = {
      id: 'o-credit-1',
      paymentMethod: 'credit',
      state: 'pending_payment',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
    };
    state.paidRow = { ...state.insertedRow, state: 'paid' };
    state.creditBalanceRow = { balanceMinor: 50_000n };
    await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'credit',
    });
    // First insert is the order row; its paymentMemo should be null.
    const orderValues = state.insertValues[0] as Record<string, unknown>;
    expect(orderValues['paymentMemo']).toBeNull();
  });

  it('A2-601: credit-funded orders insert a spend ledger row + debit user_credits + transition to paid (one txn)', async () => {
    state.insertedRow = {
      id: 'o-credit-42',
      paymentMethod: 'credit',
      state: 'pending_payment',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
    };
    state.paidRow = { ...state.insertedRow, state: 'paid' };
    state.creditBalanceRow = { balanceMinor: 50_000n };
    const result = await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'credit',
    });
    // Two insert calls: the order row, then the spend ledger row.
    expect(state.insertValues).toHaveLength(2);
    const spendInsert = state.insertValues[1] as Record<string, unknown>;
    expect(spendInsert).toMatchObject({
      userId: 'u-1',
      type: 'spend',
      amountMinor: -10_000n,
      currency: 'GBP',
      referenceType: 'order',
      referenceId: 'o-credit-42',
    });
    // Update calls: balance decrement, then order state='paid'.
    expect(state.updateSets.length).toBeGreaterThanOrEqual(2);
    const stateUpdate = state.updateSets[state.updateSets.length - 1] as Record<string, unknown>;
    expect(stateUpdate['state']).toBe('paid');
    expect(stateUpdate['paidAt']).toBeInstanceOf(Date);
    // Returned order is the paid row, not the pending_payment insert.
    expect(result.state).toBe('paid');
  });

  it('A2-601: InsufficientCreditError raised when live balance is below chargeMinor (race with handler-level check)', async () => {
    state.insertedRow = {
      id: 'o-credit-broke',
      paymentMethod: 'credit',
      state: 'pending_payment',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
    };
    // Balance is below the charge — the FOR UPDATE re-read catches it.
    state.creditBalanceRow = { balanceMinor: 500n };
    const { InsufficientCreditError } = await import('../repo.js');
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'credit',
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditError);
    // No spend row was inserted (txn rolled back on the throw; the
    // mock captures the attempted insert before the rollback, but we
    // can assert the balance update DIDN'T fire — the throw beat it).
    expect(state.updateSets).toHaveLength(0);
  });

  it('honours an explicit paymentMemo override (for tests / replays)', async () => {
    await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'xlm',
      paymentMemo: 'FIXED-MEMO-12345',
    });
    const values = state.insertValues[0] as Record<string, unknown>;
    expect(values['paymentMemo']).toBe('FIXED-MEMO-12345');
  });

  it('throws when the insert returns no row', async () => {
    state.insertedRow = undefined;
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'xlm',
      }),
    ).rejects.toThrow(/no row returned/);
  });
});

describe('findPendingOrderByMemo', () => {
  it('returns the row when a live pending_payment order matches the memo', async () => {
    const row = { id: 'o-1', paymentMemo: 'MEMO-ABC', state: 'pending_payment' };
    state.orderByMemo = row;
    const out = await findPendingOrderByMemo('MEMO-ABC');
    expect(out).toBe(row);
  });

  it('returns null when nothing matches', async () => {
    state.orderByMemo = undefined;
    const out = await findPendingOrderByMemo('missing');
    expect(out).toBeNull();
  });
});

// A2-2003: idempotency-key path on createOrder
describe('A2-2003 idempotency on createOrder', () => {
  it('findOrderByIdempotencyKey returns the matched row, null otherwise', async () => {
    const row = {
      id: 'o-prior',
      userId: 'u-1',
      idempotencyKey: 'key-1234567890ab',
    };
    state.orderByMemo = row;
    expect(await findOrderByIdempotencyKey('u-1', 'key-1234567890ab')).toBe(row);
    state.orderByMemo = undefined;
    expect(await findOrderByIdempotencyKey('u-1', 'absent-key-aaaaaa')).toBeNull();
  });

  it('passes the idempotencyKey through into the inserted row', async () => {
    state.insertedRow = {
      id: 'o-new',
      userId: 'u-1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      chargeMinor: 10_000n,
      chargeCurrency: 'GBP',
      paymentMethod: 'xlm',
      idempotencyKey: 'key-1234567890ab',
    };
    await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'xlm',
      idempotencyKey: 'key-1234567890ab',
    });
    const values = state.insertValues[0] as Record<string, unknown>;
    expect(values['idempotencyKey']).toBe('key-1234567890ab');
  });

  it('throws IdempotentOrderConflictError when the unique-index rejects (xlm path)', async () => {
    // First insert .returning() throws as if pg surfaced the unique
    // violation. The catch arm re-fetches the prior row via
    // `findOrderByIdempotencyKey` and re-throws with the existing
    // attached.
    //
    // A4-026: detector now walks `err.cause` for `code='23505'`
    // + `constraint_name`, matching refunds.ts + withdrawals.ts.
    // Forge a postgres-js-shaped error with both fields so the
    // walker recognises it.
    const priorRow = {
      id: 'o-prior',
      userId: 'u-1',
      idempotencyKey: 'key-1234567890ab',
    };
    state.orderByMemo = priorRow;
    const dupErr = Object.assign(
      new Error('duplicate key value violates unique constraint "orders_user_idempotency_unique"'),
      { code: '23505', constraint_name: 'orders_user_idempotency_unique' },
    );
    dbMock['returning']!.mockRejectedValueOnce(dupErr);
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'xlm',
        idempotencyKey: 'key-1234567890ab',
      }),
    ).rejects.toBeInstanceOf(IdempotentOrderConflictError);
  });

  it('rethrows non-idempotency errors unchanged', async () => {
    const otherErr = new Error('connection lost');
    dbMock['returning']!.mockRejectedValueOnce(otherErr);
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'xlm',
        idempotencyKey: 'key-1234567890ab',
      }),
    ).rejects.toThrow(/connection lost/);
  });
});
