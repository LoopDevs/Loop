import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Discord audit signal — hoisted so the vi.mock below references the
// same spy instance across test cases.
const { mockNotifyRefund } = vi.hoisted(() => ({
  mockNotifyRefund: vi.fn(),
}));
vi.mock('../../discord.js', () => ({
  notifyOrderRefunded: mockNotifyRefund,
}));

/**
 * Two distinct .select().from(...).where(...).limit(1) calls before the
 * transaction body runs (load order, check existing refund), then
 * inside the txn: .select() user_credits, optional insert/update on
 * user_credits, final .insert().returning() on credit_transactions.
 *
 * The mock keys each `.from(table)` call by `__name` so the FIFO of
 * results is routed to the right table — no ordering dependency.
 */
const { results, txnState } = vi.hoisted(() => ({
  results: new Map<string, unknown[][]>(),
  txnState: {
    insertReturn: new Map<string, unknown[]>(),
    insertCalls: [] as Array<{ table: string; values: unknown }>,
    updateCalls: [] as string[],
  },
}));

function enqueue(table: string, rows: unknown[]): void {
  let q = results.get(table);
  if (q === undefined) {
    q = [];
    results.set(table, q);
  }
  q.push(rows);
}
function dequeue(table: string): unknown[] {
  return results.get(table)?.shift() ?? [];
}

vi.mock('../../db/client.js', () => {
  function makeChain(table: string): unknown {
    const leaf = {
      where: vi.fn(() => leaf),
      limit: vi.fn(async () => dequeue(table)),
      then(resolve: (rows: unknown[]) => void, reject?: (e: unknown) => void): unknown {
        try {
          return Promise.resolve(dequeue(table)).then(resolve, reject);
        } catch (err) {
          if (reject !== undefined) reject(err);
          return Promise.reject(err);
        }
      },
    };
    return leaf;
  }
  function makeInsert(table: string): unknown {
    return {
      values: vi.fn((vals: unknown) => {
        txnState.insertCalls.push({ table, values: vals });
        const ret = {
          returning: vi.fn(async () => txnState.insertReturn.get(table) ?? []),
        };
        return {
          ...ret,
          then(resolve: () => void, reject?: (e: unknown) => void): unknown {
            try {
              return Promise.resolve().then(resolve, reject);
            } catch (err) {
              if (reject !== undefined) reject(err);
              return Promise.reject(err);
            }
          },
        };
      }),
    };
  }
  function makeUpdate(table: string): unknown {
    return {
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          txnState.updateCalls.push(table);
          return undefined;
        }),
      })),
    };
  }
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((t: { __name: string }) => makeChain(t.__name)),
    })),
    insert: vi.fn((t: { __name: string }) => makeInsert(t.__name)),
    update: vi.fn((t: { __name: string }) => makeUpdate(t.__name)),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  };
  return { db };
});

vi.mock('../../db/schema.js', () => ({
  orders: {
    __name: 'orders',
    id: 'id',
    userId: 'userId',
    state: 'state',
    chargeMinor: 'chargeMinor',
    chargeCurrency: 'chargeCurrency',
  },
  userCredits: {
    __name: 'userCredits',
    userId: 'userId',
    currency: 'currency',
    balanceMinor: 'balanceMinor',
  },
  creditTransactions: {
    __name: 'creditTransactions',
    userId: 'userId',
    type: 'type',
    amountMinor: 'amountMinor',
    currency: 'currency',
    referenceType: 'referenceType',
    referenceId: 'referenceId',
  },
}));

import { adminRefundOrderHandler } from '../refund.js';

function makeCtx(orderId: string | undefined, admin = { id: 'admin-1' }): Context {
  return {
    req: { param: () => orderId },
    get: (k: string) => (k === 'user' ? admin : undefined),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  results.clear();
  txnState.insertReturn.clear();
  txnState.insertCalls.length = 0;
  txnState.updateCalls.length = 0;
  mockNotifyRefund.mockReset();
});

const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('adminRefundOrderHandler', () => {
  it('400s when orderId is not a UUID', async () => {
    const res = await adminRefundOrderHandler(makeCtx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404s when the order row is missing', async () => {
    enqueue('orders', []);
    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(404);
  });

  it('409s when the order is not in failed state', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'fulfilled',
        chargeMinor: 1000n,
        chargeCurrency: 'GBP',
      },
    ]);
    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ORDER_NOT_REFUNDABLE');
  });

  it('409s when a prior refund already exists (idempotent)', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'failed',
        chargeMinor: 500n,
        chargeCurrency: 'USD',
      },
    ]);
    enqueue('creditTransactions', [{ id: 'prior-refund' }]);
    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ALREADY_REFUNDED');
  });

  it('writes the refund + inserts a fresh user_credits row for a user with no prior balance', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'failed',
        chargeMinor: 2500n,
        chargeCurrency: 'USD',
      },
    ]);
    enqueue('creditTransactions', []); // no prior refund
    enqueue('userCredits', []); // no prior balance row

    txnState.insertReturn.set('creditTransactions', [
      {
        id: 'refund-1',
        userId: USER,
        amountMinor: 2500n,
        currency: 'USD',
        createdAt: new Date('2026-04-22T12:00:00.000Z'),
      },
    ]);

    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      entry: { amountMinor: string; currency: string; orderId: string };
      balance: { balanceMinor: string; currency: string };
    };
    expect(body.entry.amountMinor).toBe('2500');
    expect(body.entry.currency).toBe('USD');
    expect(body.entry.orderId).toBe(ORDER);
    expect(body.balance).toEqual({ currency: 'USD', balanceMinor: '2500' });
    // Fresh user → INSERT user_credits, then INSERT credit_transactions.
    expect(txnState.insertCalls.map((c) => c.table)).toEqual(['userCredits', 'creditTransactions']);
  });

  it('updates user_credits when the user already has a balance', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'failed',
        chargeMinor: 1500n,
        chargeCurrency: 'GBP',
      },
    ]);
    enqueue('creditTransactions', []);
    enqueue('userCredits', [{ balanceMinor: 400n }]);

    txnState.insertReturn.set('creditTransactions', [
      {
        id: 'refund-2',
        userId: USER,
        amountMinor: 1500n,
        currency: 'GBP',
        createdAt: new Date('2026-04-22T13:00:00.000Z'),
      },
    ]);

    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { balance: { balanceMinor: string } };
    expect(body.balance.balanceMinor).toBe('1900'); // 400 + 1500
    expect(txnState.updateCalls).toContain('userCredits');
  });

  it('fires notifyOrderRefunded after a successful write with the final shape', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'failed',
        chargeMinor: 3500n,
        chargeCurrency: 'GBP',
      },
    ]);
    enqueue('creditTransactions', []); // no prior refund
    enqueue('userCredits', []);
    txnState.insertReturn.set('creditTransactions', [
      {
        id: 'refund-signal',
        userId: USER,
        amountMinor: 3500n,
        currency: 'GBP',
        createdAt: new Date('2026-04-22T14:00:00.000Z'),
      },
    ]);

    const res = await adminRefundOrderHandler(makeCtx(ORDER, { id: 'admin-signal' }));
    expect(res.status).toBe(201);
    expect(mockNotifyRefund).toHaveBeenCalledTimes(1);
    const [args] = mockNotifyRefund.mock.calls[0] as [
      {
        orderId: string;
        targetUserId: string;
        adminId: string;
        amountMinor: string;
        currency: string;
      },
    ];
    expect(args).toEqual({
      orderId: ORDER,
      targetUserId: USER,
      adminId: 'admin-signal',
      amountMinor: '3500',
      currency: 'GBP',
    });
  });

  it('does NOT fire the signal when the refund is rejected', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'fulfilled', // wrong state → 409
        chargeMinor: 1000n,
        chargeCurrency: 'GBP',
      },
    ]);
    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(409);
    expect(mockNotifyRefund).not.toHaveBeenCalled();
  });

  it('does NOT fire the signal when the order has already been refunded', async () => {
    enqueue('orders', [
      {
        id: ORDER,
        userId: USER,
        state: 'failed',
        chargeMinor: 1000n,
        chargeCurrency: 'GBP',
      },
    ]);
    enqueue('creditTransactions', [{ id: 'prior-refund' }]); // idempotency hit
    const res = await adminRefundOrderHandler(makeCtx(ORDER));
    expect(res.status).toBe(409);
    expect(mockNotifyRefund).not.toHaveBeenCalled();
  });
});
