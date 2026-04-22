import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Drizzle chain mock driven by the table name passed to `.from(table)`.
 * Each table has its own FIFO of rows dequeued on either `.limit(N)`
 * or via the chain being awaited directly.
 *
 * Transactions run synchronously against the same dbMock — the
 * transaction body sees the same enqueued rows a plain handler
 * would. Tests orchestrate `.insert().values()` / `.update().set()`
 * responses via `txnState.onInsert` / `txnState.onUpdate` hooks so
 * we can simulate the non-negative CHECK tripping.
 */
const { results, txnState } = vi.hoisted(() => ({
  results: new Map<string, unknown[][]>(),
  txnState: {
    insertReturn: new Map<string, unknown[]>(),
    onInsert: null as ((table: string, values: unknown) => void) | null,
    onUpdate: null as ((table: string) => void) | null,
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
        txnState.onInsert?.(table, vals);
        const ret = {
          returning: vi.fn(async () => txnState.insertReturn.get(table) ?? []),
        };
        // Bare `.values()` (no .returning() call) is awaited directly.
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
          txnState.onUpdate?.(table);
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
  users: { __name: 'users', id: 'id', homeCurrency: 'homeCurrency' },
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
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));

import { adminCreditAdjustmentHandler } from '../credit-adjustments.js';

function makeCtx(args: {
  userId: string | undefined;
  body: unknown;
  admin?: { id: string };
}): Context {
  return {
    req: {
      param: () => args.userId,
      json: async () => args.body,
    },
    get: (k: string) => {
      if (k === 'user') return args.admin ?? { id: 'admin-uuid' };
      return undefined;
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
  txnState.insertReturn.clear();
  txnState.onInsert = null;
  txnState.onUpdate = null;
});

const VALID_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('adminCreditAdjustmentHandler', () => {
  it('400s when userId is not a UUID', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: 'nope',
        body: { amountMinor: '100', currency: 'GBP', note: 'test credit' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s when amountMinor is missing or malformed', async () => {
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: { amountMinor: 'abc', currency: 'GBP', note: 'test' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s when amountMinor is zero', async () => {
    enqueue('users', [{ id: VALID_UUID, homeCurrency: 'GBP' }]);
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: { amountMinor: '0', currency: 'GBP', note: 'noop adjustment' },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message.toLowerCase()).toContain('non-zero');
  });

  it('404s when the target user does not exist', async () => {
    enqueue('users', []);
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: { amountMinor: '100', currency: 'GBP', note: 'test' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('400s when the adjustment currency differs from the user home currency', async () => {
    enqueue('users', [{ id: VALID_UUID, homeCurrency: 'GBP' }]);
    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: { amountMinor: '100', currency: 'USD', note: 'misrouted credit' },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CURRENCY_MISMATCH');
  });

  it('inserts a positive adjustment against a fresh user (no user_credits row yet)', async () => {
    enqueue('users', [{ id: VALID_UUID, homeCurrency: 'GBP' }]);
    // No user_credits row → first .limit(1) dequeue returns [].
    enqueue('userCredits', []);
    const inserted = {
      id: 'ledger-1',
      userId: VALID_UUID,
      type: 'adjustment',
      amountMinor: 500n,
      currency: 'GBP',
      referenceType: 'admin_adjustment',
      referenceId: ADMIN_UUID,
      note: 'goodwill credit after support chat',
      createdAt: new Date('2026-04-22T10:00:00.000Z'),
    };
    txnState.insertReturn.set('creditTransactions', [inserted]);

    const insertCalls: Array<{ table: string; values: unknown }> = [];
    txnState.onInsert = (table, values) => insertCalls.push({ table, values });

    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: { amountMinor: '500', currency: 'GBP', note: 'goodwill credit after support chat' },
        admin: { id: ADMIN_UUID },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      entry: { note: string; amountMinor: string; referenceId: string };
      balance: { currency: string; balanceMinor: string };
    };
    expect(body.entry.amountMinor).toBe('500');
    expect(body.entry.note).toBe('goodwill credit after support chat');
    expect(body.entry.referenceId).toBe(ADMIN_UUID);
    expect(body.balance).toEqual({ currency: 'GBP', balanceMinor: '500' });
    // Fresh user → INSERT user_credits, then INSERT credit_transactions.
    expect(insertCalls.map((c) => c.table)).toEqual(['userCredits', 'creditTransactions']);
  });

  it('updates existing user_credits when the user already has a balance', async () => {
    enqueue('users', [{ id: VALID_UUID, homeCurrency: 'USD' }]);
    enqueue('userCredits', [{ balanceMinor: 2500n }]);
    txnState.insertReturn.set('creditTransactions', [
      {
        id: 'ledger-2',
        userId: VALID_UUID,
        type: 'adjustment',
        amountMinor: -700n,
        currency: 'USD',
        referenceType: 'admin_adjustment',
        referenceId: ADMIN_UUID,
        note: 'clawback after merchant dispute',
        createdAt: new Date('2026-04-22T11:00:00.000Z'),
      },
    ]);

    const updatedTables: string[] = [];
    txnState.onUpdate = (table) => updatedTables.push(table);

    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: {
          amountMinor: '-700',
          currency: 'USD',
          note: 'clawback after merchant dispute',
        },
        admin: { id: ADMIN_UUID },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { balance: { balanceMinor: string } };
    // 2500 + (-700) = 1800
    expect(body.balance.balanceMinor).toBe('1800');
    expect(updatedTables).toContain('userCredits');
  });

  it('409s when a negative adjustment would push the balance below zero', async () => {
    enqueue('users', [{ id: VALID_UUID, homeCurrency: 'EUR' }]);
    enqueue('userCredits', [{ balanceMinor: 500n }]);

    const res = await adminCreditAdjustmentHandler(
      makeCtx({
        userId: VALID_UUID,
        body: { amountMinor: '-600', currency: 'EUR', note: 'overdraft test' },
        admin: { id: ADMIN_UUID },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
  });
});
