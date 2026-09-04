/**
 * Order-repository tests (ADR 052 mirror model): the create insert
 * shape, the idempotency-conflict resolution contract, and the
 * guarded CTX-identifier / economics writers, through a captured db
 * chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, state } = vi.hoisted(() => {
  const s = {
    insertValues: undefined as Record<string, unknown> | undefined,
    insertShouldThrow: null as unknown,
    updateSet: undefined as Record<string, unknown> | undefined,
    updateCount: 0,
    findFirstRows: [] as unknown[],
  };
  const chain: Record<string, unknown> = {};
  chain['insert'] = vi.fn(() => chain);
  chain['values'] = vi.fn((v: Record<string, unknown>) => {
    if (s.insertShouldThrow !== null) throw s.insertShouldThrow;
    s.insertValues = v;
    return chain;
  });
  chain['returning'] = vi.fn(async () => [{ id: 'o-new', ...s.insertValues }]);
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: Record<string, unknown>) => {
    s.updateSet = v;
    s.updateCount++;
    return chain;
  });
  chain['where'] = vi.fn(async () => undefined);
  chain['query'] = {
    orders: {
      findFirst: vi.fn(async () => s.findFirstRows.shift() ?? null),
      findMany: vi.fn(async () => []),
    },
  };
  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));

import {
  createOrder,
  IdempotentOrderConflictError,
  recordCtxCreate,
  recordOrderEconomics,
} from '../repo.js';

function pgUniqueViolation(): Error {
  const err = new Error('duplicate key value violates unique constraint') as Error & {
    code: string;
    constraint_name: string;
  };
  err.code = '23505';
  err.constraint_name = 'orders_user_idempotency_unique';
  return err;
}

beforeEach(() => {
  state.insertValues = undefined;
  state.insertShouldThrow = null;
  state.updateSet = undefined;
  state.updateCount = 0;
  state.findFirstRows = [];
});

describe('createOrder', () => {
  it('inserts an unpaid mirror row with the charge provisionally pinned to face value', async () => {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 2500n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    expect(row.id).toBe('o-new');
    expect(state.insertValues).toMatchObject({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 2500n,
      currency: 'USD',
      chargeMinor: 2500n,
      chargeCurrency: 'USD',
      userCashbackMinor: 0n,
      paymentCryptoCurrency: 'XLM',
      state: 'unpaid',
    });
    expect(state.insertValues).not.toHaveProperty('idempotencyKey');
  });

  it('carries the idempotency key onto the row when supplied', async () => {
    await createOrder({
      userId: 'u-1',
      merchantId: 'm-1',
      faceValueMinor: 100n,
      currency: 'GBP',
      paymentCryptoCurrency: 'DASH',
      idempotencyKey: 'k'.repeat(20),
    });
    expect(state.insertValues).toMatchObject({ idempotencyKey: 'k'.repeat(20) });
  });

  it('A2-2003: a (user, key) unique violation resolves to IdempotentOrderConflictError carrying the prior row', async () => {
    state.insertShouldThrow = pgUniqueViolation();
    state.findFirstRows = [{ id: 'o-prior', state: 'unpaid' }];
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm-1',
        faceValueMinor: 100n,
        currency: 'USD',
        paymentCryptoCurrency: 'XLM',
        idempotencyKey: 'k'.repeat(20),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(IdempotentOrderConflictError);
      expect((err as IdempotentOrderConflictError).existing.id).toBe('o-prior');
      return true;
    });
  });

  it('rethrows non-idempotency insert failures unchanged', async () => {
    state.insertShouldThrow = new Error('connection reset');
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm-1',
        faceValueMinor: 100n,
        currency: 'USD',
        paymentCryptoCurrency: 'XLM',
      }),
    ).rejects.toThrow('connection reset');
  });
});

describe('recordCtxCreate', () => {
  it('writes the CTX identifiers + actual charge', async () => {
    await recordCtxCreate('o-1', {
      ctxOrderId: 'ctx-1',
      ctxPaymentId: 'pay-1',
      chargeMinor: 2400n,
      chargeCurrency: 'USD',
    });
    expect(state.updateSet).toEqual({
      ctxOrderId: 'ctx-1',
      ctxPaymentId: 'pay-1',
      chargeMinor: 2400n,
      chargeCurrency: 'USD',
    });
  });

  it('leaves absent fields untouched (null = unknown, never overwrite)', async () => {
    await recordCtxCreate('o-1', {
      ctxOrderId: 'ctx-1',
      ctxPaymentId: null,
      chargeMinor: null,
      chargeCurrency: null,
    });
    expect(state.updateSet).toEqual({ ctxOrderId: 'ctx-1' });
  });
});

describe('recordOrderEconomics', () => {
  it('writes only the non-null economics fields', async () => {
    await recordOrderEconomics('o-1', {
      userCashbackMinor: 50n,
      expectedCommissionMinor: null,
    });
    expect(state.updateSet).toEqual({ userCashbackMinor: 50n });
  });

  it('is a no-op when both fields are unknown', async () => {
    await recordOrderEconomics('o-1', {
      userCashbackMinor: null,
      expectedCommissionMinor: null,
    });
    expect(state.updateCount).toBe(0);
  });
});
