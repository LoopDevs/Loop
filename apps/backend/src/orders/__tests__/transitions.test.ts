import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Transitions exercise `UPDATE ... WHERE state = <expected> RETURNING`
 * + an optional txn (markOrderFulfilled). We mock the db as a
 * chainable thing that:
 *   - records the last set + where payloads
 *   - returns a stashed row from `.returning()`
 *   - forwards `db.transaction(cb)` → `cb(txMock)` so the fulfilled
 *     path's multi-step write can be observed.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    returningRows: unknown[];
    updateSet: unknown;
    updateWhereCount: number;
    insertCreditCalls: unknown[];
    upsertUserCreditsCalls: unknown[];
    insertPendingPayoutCalls: unknown[];
    upsertSet: unknown;
    // User-row lookup inside the fulfilled txn (ADR 015).
    userLookupRows: unknown[];
  }
  const s: State = {
    returningRows: [],
    updateSet: undefined,
    updateWhereCount: 0,
    insertCreditCalls: [],
    upsertUserCreditsCalls: [],
    insertPendingPayoutCalls: [],
    upsertSet: undefined,
    userLookupRows: [],
  };

  // Outer db chain — shared between the non-txn path and the tx
  // callback. The chain methods all return `chain` so Drizzle's
  // fluent syntax works.
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: unknown) => {
    s.updateSet = v;
    return chain;
  });
  chain['where'] = vi.fn(() => {
    s.updateWhereCount++;
    return chain;
  });
  chain['returning'] = vi.fn(async (_projection?: unknown) => s.returningRows);
  chain['insert'] = vi.fn((table: unknown) => {
    const name = (table as Record<string, unknown>)['__name'];
    // Tag the current insert so .values can route to the right bucket.
    (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'] =
      typeof name === 'string' ? name : undefined;
    return chain;
  });
  chain['values'] = vi.fn((v: unknown) => {
    const last = (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'];
    if (last === 'creditTransactions') s.insertCreditCalls.push(v);
    else if (last === 'userCredits') s.upsertUserCreditsCalls.push(v);
    else if (last === 'pendingPayouts') s.insertPendingPayoutCalls.push(v);
    return chain;
  });
  chain['onConflictDoUpdate'] = vi.fn((arg: { set: unknown }) => {
    s.upsertSet = arg.set;
    return chain;
  });
  // The pending_payouts insert calls onConflictDoNothing — a no-op on
  // the mock chain; the insert gets captured upstream.
  chain['onConflictDoNothing'] = vi.fn(() => chain);

  // `select({ ... }).from(users).where(...)` path used by the
  // fulfillment txn to look up the user's stellar_address +
  // home_currency. Resolves to `state.userLookupRows` so tests
  // control what the user row looks like (or is missing).
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  // .where is shared with the update path above; overwrite behaviour
  // to still track updates AND resolve select(...).from(...).where(...)
  // as a thenable returning the user rows.
  const selectAwarePromise = {
    then: (resolve: (rows: unknown[]) => unknown): unknown => resolve(s.userLookupRows),
  };
  (chain as unknown as { where: unknown })['where'] = vi.fn(() => {
    s.updateWhereCount++;
    // The caller either `.returning()`s (update path) or `await`s
    // directly (select path). Returning a value that supports both
    // keeps the chain happy for both callers.
    return Object.assign(chain, selectAwarePromise);
  });

  // db.transaction(cb) just calls cb with the same chain — we want
  // to observe writes against the mock, not fight with an isolated
  // transactional mock.
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: {
    id: 'id',
    state: 'state',
    ctxOrderId: 'ctx_order_id',
    ctxOperatorId: 'ctx_operator_id',
    paidAt: 'paid_at',
    paymentReceivedAt: 'payment_received_at',
    procuredAt: 'procured_at',
    fulfilledAt: 'fulfilled_at',
    failedAt: 'failed_at',
    failureReason: 'failure_reason',
    createdAt: 'created_at',
    __name: 'orders',
  },
  creditTransactions: {
    userId: 'user_id',
    type: 'type',
    amountMinor: 'amount_minor',
    currency: 'currency',
    referenceType: 'reference_type',
    referenceId: 'reference_id',
    __name: 'creditTransactions',
  },
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    balanceMinor: 'balance_minor',
    updatedAt: 'updated_at',
    __name: 'userCredits',
  },
  users: {
    id: 'id',
    stellarAddress: 'stellar_address',
    homeCurrency: 'home_currency',
    __name: 'users',
  },
  pendingPayouts: {
    orderId: 'order_id',
    __name: 'pendingPayouts',
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
// Payout-intent builder — default: "pay" when userCashbackMinor > 0,
// with a fixed issuer/asset/address. Tests that need skip paths can
// override via `payoutBuilderMock.decision = { kind: 'skip', reason: 'no_address' }`.
const { payoutBuilderMock } = vi.hoisted(() => ({
  payoutBuilderMock: {
    decision: null as unknown,
  },
}));
vi.mock('../../credits/payout-builder.js', () => ({
  buildPayoutIntent: (args: {
    userCashbackMinor: bigint;
    stellarAddress: string | null;
    homeCurrency: string;
    memoSeed: string;
  }) => {
    if (payoutBuilderMock.decision !== null) return payoutBuilderMock.decision;
    if (args.userCashbackMinor <= 0n) return { kind: 'skip', reason: 'no_cashback' };
    if (args.stellarAddress === null) return { kind: 'skip', reason: 'no_address' };
    return {
      kind: 'pay',
      intent: {
        to: args.stellarAddress,
        assetCode: `${args.homeCurrency}LOOP`,
        assetIssuer: 'GISSUER',
        amountStroops: args.userCashbackMinor * 100_000n,
        memoText: args.memoSeed.slice(0, 28),
      },
    };
  },
}));

import {
  markOrderPaid,
  markOrderProcuring,
  markOrderFulfilled,
  markOrderFailed,
  sweepExpiredOrders,
} from '../transitions.js';

beforeEach(() => {
  state.returningRows = [];
  state.updateSet = undefined;
  state.updateWhereCount = 0;
  state.insertCreditCalls = [];
  state.upsertUserCreditsCalls = [];
  state.insertPendingPayoutCalls = [];
  state.upsertSet = undefined;
  state.userLookupRows = [];
  payoutBuilderMock.decision = null;
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('markOrderPaid', () => {
  it('returns the updated row on a valid pending_payment → paid transition', async () => {
    const row = { id: 'o-1', state: 'paid' };
    state.returningRows = [row];
    const result = await markOrderPaid('o-1');
    expect(result).toEqual(row);
    expect(state.updateSet).toMatchObject({ state: 'paid' });
  });

  it('returns null when no row matches the expected state', async () => {
    state.returningRows = [];
    const result = await markOrderPaid('missing');
    expect(result).toBeNull();
  });

  it('honours a supplied payment_received_at', async () => {
    state.returningRows = [{ id: 'o-1' }];
    const at = new Date('2026-04-21T12:00:00Z');
    await markOrderPaid('o-1', { paymentReceivedAt: at });
    expect(state.updateSet).toMatchObject({ paymentReceivedAt: at });
  });
});

describe('markOrderProcuring', () => {
  it('sets state=procuring and captures the operator id', async () => {
    state.returningRows = [{ id: 'o-1', state: 'procuring' }];
    const result = await markOrderProcuring('o-1', { ctxOperatorId: 'primary' });
    expect(result?.state).toBe('procuring');
    expect(state.updateSet).toMatchObject({
      state: 'procuring',
      ctxOperatorId: 'primary',
    });
  });

  it('returns null when the order is not in paid state', async () => {
    state.returningRows = [];
    const result = await markOrderProcuring('o-1', { ctxOperatorId: 'primary' });
    expect(result).toBeNull();
  });
});

describe('markOrderFulfilled', () => {
  const baseOrder = {
    id: 'o-1',
    userId: 'u-1',
    merchantId: 'm-1',
    currency: 'GBP',
    chargeCurrency: 'GBP',
    userCashbackMinor: 500n,
    faceValueMinor: 10_000n,
    chargeMinor: 10_000n,
    state: 'fulfilled' as const,
  };

  it('writes the order update, a cashback credit_transactions row, and an upsert for user_credits', async () => {
    state.returningRows = [baseOrder];
    const result = await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(result?.id).toBe('o-1');
    // Order update called.
    expect(state.updateSet).toMatchObject({
      state: 'fulfilled',
      ctxOrderId: 'ctx-abc',
    });
    // Cashback transaction written.
    expect(state.insertCreditCalls).toHaveLength(1);
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'cashback',
      amountMinor: 500n,
      currency: 'GBP',
      referenceType: 'order',
      referenceId: 'o-1',
    });
    // user_credits upserted at +500.
    expect(state.upsertUserCreditsCalls).toHaveLength(1);
    expect(state.upsertUserCreditsCalls[0]).toMatchObject({
      userId: 'u-1',
      currency: 'GBP',
      balanceMinor: 500n,
    });
    expect(state.upsertSet).toBeDefined();
  });

  it('skips ledger writes when userCashbackMinor is 0', async () => {
    state.returningRows = [{ ...baseOrder, userCashbackMinor: 0n }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.upsertUserCreditsCalls).toHaveLength(0);
  });

  it('returns null and performs no ledger writes when the order is not procuring', async () => {
    state.returningRows = [];
    const result = await markOrderFulfilled('missing', { ctxOrderId: 'x' });
    expect(result).toBeNull();
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.upsertUserCreditsCalls).toHaveLength(0);
  });

  it('runs inside a db.transaction so a partial failure rolls back', async () => {
    state.returningRows = [baseOrder];
    await markOrderFulfilled('o-1', { ctxOrderId: 'x' });
    expect(dbMock['transaction']!).toHaveBeenCalled();
  });

  // ─── ADR 015 — pending payout insert inside the fulfillment txn ───────────
  it('inserts a pending_payouts row when the user qualifies (address + home-currency match)', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      userId: 'u-1',
      orderId: 'o-1',
      toAddress: 'GDESTINATION',
      assetCode: 'GBPLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: 50_000_000n, // 500 × 100_000
    });
  });

  it('skips the payout when the user has no linked stellar address', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [{ stellarAddress: null, homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('skips the payout when no user row is found', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('skips the payout when order.chargeCurrency diverges from user.home_currency', async () => {
    // Happens only if the user's home currency was changed post-
    // order by support. The ledger still wrote in charge_currency;
    // paying out in a different LOOP asset would send the wrong
    // denomination, so log + skip.
    state.returningRows = [{ ...baseOrder, chargeCurrency: 'USD' }];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('pays out a cross-FX order where catalog currency differs from home (ledger is home-denominated)', async () => {
    // USD catalog gift card, GBP user. order.currency='USD' but
    // chargeCurrency='GBP' + userCashbackMinor is in GBP pence. The
    // payout MUST fire in GBPLOOP — previously blocked by the
    // `order.currency !== home` guard, now permitted because the
    // ledger-in-home-currency refactor made it safe.
    state.returningRows = [{ ...baseOrder, currency: 'USD', chargeCurrency: 'GBP' }];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      assetCode: 'GBPLOOP',
    });
  });

  it('skips the payout when builder returns a skip decision (e.g. no_issuer)', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    payoutBuilderMock.decision = { kind: 'skip', reason: 'no_issuer' };
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });
});

describe('markOrderFailed', () => {
  it('sets state=failed + failure_reason', async () => {
    state.returningRows = [{ id: 'o-1', state: 'failed', failureReason: 'CTX rejected' }];
    const result = await markOrderFailed('o-1', 'CTX rejected');
    expect(result?.state).toBe('failed');
    expect(state.updateSet).toMatchObject({
      state: 'failed',
      failureReason: 'CTX rejected',
    });
  });

  it('returns null for already-terminal orders', async () => {
    state.returningRows = [];
    const result = await markOrderFailed('already-fulfilled', 'too late');
    expect(result).toBeNull();
  });
});

describe('markOrderProcuring — procured_at pin', () => {
  it('sets procured_at alongside state=procuring', async () => {
    state.returningRows = [{ id: 'o-1', state: 'procuring' }];
    const { markOrderProcuring } = await import('../transitions.js');
    await markOrderProcuring('o-1', { ctxOperatorId: 'pool' });
    expect(state.updateSet).toMatchObject({
      state: 'procuring',
      ctxOperatorId: 'pool',
      procuredAt: expect.any(Date),
    });
  });
});

describe('sweepStuckProcurement', () => {
  it('returns the number of rows swept', async () => {
    state.returningRows = [{ id: 'a' }, { id: 'b' }];
    const { sweepStuckProcurement } = await import('../transitions.js');
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const n = await sweepStuckProcurement(cutoff);
    expect(n).toBe(2);
    expect(state.updateSet).toMatchObject({
      state: 'failed',
      failureReason: 'procurement_timeout',
    });
  });

  it('returns 0 when nothing is stuck', async () => {
    state.returningRows = [];
    const { sweepStuckProcurement } = await import('../transitions.js');
    const n = await sweepStuckProcurement(new Date());
    expect(n).toBe(0);
  });
});

describe('sweepExpiredOrders', () => {
  it('returns the count of rows transitioned', async () => {
    state.returningRows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const n = await sweepExpiredOrders(cutoff);
    expect(n).toBe(3);
    expect(state.updateSet).toMatchObject({ state: 'expired' });
  });

  it('returns 0 when nothing is due for expiry', async () => {
    state.returningRows = [];
    const n = await sweepExpiredOrders(new Date());
    expect(n).toBe(0);
  });
});
