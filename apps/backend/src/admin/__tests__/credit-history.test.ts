import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

/**
 * Standard drizzle-chain mock: `.select().from().where().orderBy().limit()`.
 * Tests push rows into `dbState.rows` and the terminal `.limit` dequeues
 * them; the `.where()` condition captured for assertion coverage.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    whereCalls: [] as unknown[],
    limitCalls: [] as number[],
  },
}));

vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn((cond: unknown) => {
      dbState.whereCalls.push(cond);
      return leaf;
    }),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async (n: number) => {
      dbState.limitCalls.push(n);
      return dbState.rows;
    }),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => leaf),
      })),
    },
  };
});

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    id: 'id',
    userId: 'userId',
    type: 'type',
    amountMinor: 'amountMinor',
    currency: 'currency',
    referenceType: 'referenceType',
    referenceId: 'referenceId',
    note: 'note',
    createdAt: 'createdAt',
  },
}));

import { adminCreditHistoryHandler } from '../credit-history.js';

function makeCtx(userId: string | undefined, query: Record<string, string> = {}): Context {
  return {
    req: {
      param: () => userId,
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  dbState.rows = [];
  dbState.whereCalls.length = 0;
  dbState.limitCalls.length = 0;
});

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('adminCreditHistoryHandler', () => {
  it('400s when userId is not a UUID', async () => {
    const res = await adminCreditHistoryHandler(makeCtx('nope'));
    expect(res.status).toBe(400);
  });

  it('400s when `before` is not a parseable date', async () => {
    const res = await adminCreditHistoryHandler(makeCtx(USER, { before: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('returns entries with bigint-strings + ISO timestamps + note', async () => {
    const now = new Date('2026-04-22T10:00:00.000Z');
    dbState.rows = [
      {
        id: 'tx-1',
        userId: USER,
        type: 'adjustment',
        amountMinor: 500n,
        currency: 'GBP',
        referenceType: 'admin_adjustment',
        referenceId: 'admin-uuid',
        note: 'goodwill credit',
        createdAt: now,
      },
      {
        id: 'tx-2',
        userId: USER,
        type: 'cashback',
        amountMinor: 120n,
        currency: 'GBP',
        referenceType: 'order',
        referenceId: 'order-uuid',
        note: null,
        createdAt: new Date('2026-04-21T09:00:00.000Z'),
      },
    ];
    const res = await adminCreditHistoryHandler(makeCtx(USER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{
        id: string;
        type: string;
        amountMinor: string;
        note: string | null;
        createdAt: string;
      }>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      id: 'tx-1',
      type: 'adjustment',
      amountMinor: '500',
      note: 'goodwill credit',
      createdAt: '2026-04-22T10:00:00.000Z',
    });
    expect(body.entries[1]).toMatchObject({
      id: 'tx-2',
      type: 'cashback',
      amountMinor: '120',
      note: null,
    });
  });

  it('clamps limit to [1, 100] and passes it through to drizzle', async () => {
    dbState.rows = [];
    await adminCreditHistoryHandler(makeCtx(USER, { limit: '5' }));
    await adminCreditHistoryHandler(makeCtx(USER, { limit: '0' }));
    await adminCreditHistoryHandler(makeCtx(USER, { limit: '10000' }));
    await adminCreditHistoryHandler(makeCtx(USER, { limit: 'nonsense' }));
    expect(dbState.limitCalls).toEqual([5, 1, 100, 20]);
  });

  it('returns empty entries array when the user has no ledger rows', async () => {
    dbState.rows = [];
    const res = await adminCreditHistoryHandler(makeCtx(USER));
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});
