import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Drizzle chain mock keyed by the table passed to `.from(table)`.
 * Each table has its own FIFO of result arrays; the chain's terminal
 * method dequeues from the currently-bound table's queue.
 *
 * The handler runs five independent queries — one user fetch (ends
 * at `.limit(1)`) and four parallel aggregations (end at `.where(...)`
 * awaited directly). Keying by table means the parallel aggregations
 * don't race each other for FIFO slots.
 */
const { results } = vi.hoisted(() => ({
  results: new Map<string, unknown[][]>(),
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
  const q = results.get(table);
  return q?.shift() ?? [];
}

vi.mock('../../db/client.js', () => {
  function makeChain(table: string): unknown {
    const thenable = {
      where: vi.fn(() => thenable),
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
    return thenable;
  }
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: { __name: string }) => makeChain(table.__name)),
      })),
    },
  };
});

vi.mock('../../db/schema.js', () => ({
  users: { __name: 'users', id: 'id' },
  userCredits: {
    __name: 'userCredits',
    userId: 'userId',
    currency: 'currency',
    balanceMinor: 'balanceMinor',
  },
  creditTransactions: {
    __name: 'creditTransactions',
    userId: 'userId',
    currency: 'currency',
    type: 'type',
    amountMinor: 'amountMinor',
  },
  orders: { __name: 'orders', userId: 'userId' },
  pendingPayouts: { __name: 'pendingPayouts', userId: 'userId', state: 'state' },
}));

import { adminGetUserHandler } from '../users.js';

function makeCtx(userId: string | undefined): Context {
  return {
    req: {
      param: (_k: string) => userId,
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  results.clear();
});

describe('adminGetUserHandler', () => {
  it('400s when userId is missing', async () => {
    const res = await adminGetUserHandler(makeCtx(undefined));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('400s when userId is not a UUID', async () => {
    const res = await adminGetUserHandler(makeCtx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404s when the user row is missing', async () => {
    enqueue('users', []);
    const res = await adminGetUserHandler(makeCtx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('shapes a full summary when all four aggregations return non-zero rows', async () => {
    const createdAt = new Date('2025-01-15T09:00:00.000Z');
    enqueue('users', [
      {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'user@example.com',
        isAdmin: false,
        homeCurrency: 'GBP',
        stellarAddress: 'GTEST',
        createdAt,
      },
    ]);
    enqueue('userCredits', [{ total: '4500' }]);
    enqueue('creditTransactions', [{ total: '12500' }]);
    enqueue('orders', [{ count: '17' }]);
    enqueue('pendingPayouts', [{ count: '2' }]);

    const res = await adminGetUserHandler(makeCtx('22222222-2222-4222-8222-222222222222'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: {
        id: string;
        email: string;
        homeCurrency: string;
        balanceMinor: string;
        lifetimeCashbackEarnedMinor: string;
        orderCount: string;
        pendingPayoutCount: string;
        stellarAddress: string | null;
        isAdmin: boolean;
        createdAt: string;
      };
    };
    expect(body.user).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'user@example.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: 'GTEST',
      createdAt: '2025-01-15T09:00:00.000Z',
      balanceMinor: '4500',
      lifetimeCashbackEarnedMinor: '12500',
      orderCount: '17',
      pendingPayoutCount: '2',
    });
  });

  it('zeros every aggregate when the user has no ledger / order / payout rows', async () => {
    enqueue('users', [
      {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'fresh@example.com',
        isAdmin: false,
        homeCurrency: 'USD',
        stellarAddress: null,
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    ]);
    // COALESCE returns '0' even with no matching rows — mimic that.
    enqueue('userCredits', [{ total: '0' }]);
    enqueue('creditTransactions', [{ total: '0' }]);
    enqueue('orders', [{ count: '0' }]);
    enqueue('pendingPayouts', [{ count: '0' }]);

    const res = await adminGetUserHandler(makeCtx('33333333-3333-4333-8333-333333333333'));
    const body = (await res.json()) as {
      user: {
        balanceMinor: string;
        lifetimeCashbackEarnedMinor: string;
        orderCount: string;
        pendingPayoutCount: string;
        stellarAddress: string | null;
      };
    };
    expect(body.user.balanceMinor).toBe('0');
    expect(body.user.lifetimeCashbackEarnedMinor).toBe('0');
    expect(body.user.orderCount).toBe('0');
    expect(body.user.pendingPayoutCount).toBe('0');
    expect(body.user.stellarAddress).toBeNull();
  });
});
