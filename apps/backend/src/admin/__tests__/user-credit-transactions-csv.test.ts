import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as Array<{
      id: string;
      createdAt: Date;
      type: string;
      amountMinor: bigint;
      currency: string;
      referenceType: string | null;
      referenceId: string | null;
    }>,
    throw: false,
  },
}));
vi.mock('../../db/client.js', () => {
  const leaf = {
    where: vi.fn(() => leaf),
    orderBy: vi.fn(() => leaf),
    limit: vi.fn(async () => {
      if (dbState.throw) throw new Error('db exploded');
      return dbState.rows;
    }),
  };
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => leaf) })),
    },
  };
});
vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    userId: 'user_id',
    createdAt: 'created_at',
  },
}));

import { adminUserCreditTransactionsCsvHandler } from '../user-credit-transactions-csv.js';

const VALID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeCtx(userId: string | undefined): Context {
  return {
    req: {
      param: (k: string) => (k === 'userId' ? userId : undefined),
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
  dbState.throw = false;
});

describe('adminUserCreditTransactionsCsvHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx(undefined));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a UUID', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('emits CSV with header + rows, attachment headers naming the user', async () => {
    dbState.rows = [
      {
        id: 't-1',
        createdAt: new Date('2026-04-20T12:00:00Z'),
        type: 'cashback',
        amountMinor: 500n,
        currency: 'GBP',
        referenceType: 'order',
        referenceId: 'o-1',
      },
    ];
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx(VALID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="loop-user-${VALID}-credit-transactions.csv"`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.text();
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Transaction ID,Created at (UTC),Type,Amount (minor),Currency,Reference type,Reference ID',
    );
    expect(lines[1]).toBe('t-1,2026-04-20T12:00:00.000Z,cashback,500,GBP,order,o-1');
  });

  it('serializes null reference fields as empty cells', async () => {
    dbState.rows = [
      {
        id: 't-2',
        createdAt: new Date('2026-04-20T12:00:00Z'),
        type: 'adjustment',
        amountMinor: -50n,
        currency: 'GBP',
        referenceType: null,
        referenceId: null,
      },
    ];
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx(VALID));
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[1]).toBe('t-2,2026-04-20T12:00:00.000Z,adjustment,-50,GBP,,');
  });

  it('emits only the header when the user has no ledger rows', async () => {
    dbState.rows = [];
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx(VALID));
    const body = await res.text();
    expect(body.trim().split('\r\n')).toHaveLength(1);
  });

  it('500 when the db read throws', async () => {
    dbState.throw = true;
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx(VALID));
    expect(res.status).toBe(500);
  });
});
