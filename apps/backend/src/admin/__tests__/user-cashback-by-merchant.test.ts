import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  userRow: { homeCurrency: 'GBP' } as { homeCurrency: string } | undefined,
  aggRows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

// `.select(...).from(...).where(...).limit(N)` returns a Promise-ish
// awaitable of the user-resolution row. `db.execute(sql\`...\`)`
// returns the aggregate. Two distinct paths, one client mock.
const limitMock = vi.fn(async (_n: number) => {
  return state.userRow === undefined ? [] : [state.userRow];
});
const whereMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => selectMock(),
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.aggRows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    userId: 'credit_transactions.user_id',
    type: 'credit_transactions.type',
    amountMinor: 'credit_transactions.amount_minor',
    currency: 'credit_transactions.currency',
    referenceType: 'credit_transactions.reference_type',
    referenceId: 'credit_transactions.reference_id',
    createdAt: 'credit_transactions.created_at',
  },
  orders: {
    id: 'orders.id',
    merchantId: 'orders.merchant_id',
  },
  users: { id: 'users.id', homeCurrency: 'users.home_currency' },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (_a: unknown, _b: unknown) => true,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      {},
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminUserCashbackByMerchantHandler } from '../user-cashback-by-merchant.js';

function makeCtx(params: Record<string, string> = {}, query: Record<string, string> = {}): Context {
  return {
    req: {
      param: (k: string) => params[k],
      query: (k: string) => query[k],
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const validUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  state.userRow = { homeCurrency: 'GBP' };
  state.aggRows = [];
  state.throwErr = null;
  limitMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminUserCashbackByMerchantHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserCashbackByMerchantHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminUserCashbackByMerchantHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('404 when the target user does not exist', async () => {
    state.userRow = undefined;
    const res = await adminUserCashbackByMerchantHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(404);
  });

  it('returns empty rows in the caller userId + home currency for a user with no cashback', async () => {
    state.aggRows = [];
    const res = await adminUserCashbackByMerchantHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      currency: string;
      since: string;
      rows: unknown[];
    };
    expect(body.userId).toBe(validUserId);
    expect(body.currency).toBe('GBP');
    expect(body.rows).toEqual([]);
  });

  it('normalises bigint/number aggregates to string and ISO-serialises timestamps', async () => {
    state.aggRows = [
      {
        merchant_id: 'amazon_us',
        cashback_minor: 12_500n,
        order_count: '5',
        last_earned_at: new Date('2026-04-22T10:00:00Z'),
      },
    ];
    const res = await adminUserCashbackByMerchantHandler(makeCtx({ userId: validUserId }));
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows[0]).toEqual({
      merchantId: 'amazon_us',
      cashbackMinor: '12500',
      orderCount: 5,
      lastEarnedAt: '2026-04-22T10:00:00.000Z',
    });
  });

  it('400 on malformed ?since', async () => {
    const res = await adminUserCashbackByMerchantHandler(
      makeCtx({ userId: validUserId }, { since: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when ?since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminUserCashbackByMerchantHandler(
      makeCtx({ userId: validUserId }, { since: tooOld }),
    );
    expect(res.status).toBe(400);
  });

  it('echoes the target user home currency, not USD or some default', async () => {
    state.userRow = { homeCurrency: 'EUR' };
    const res = await adminUserCashbackByMerchantHandler(makeCtx({ userId: validUserId }));
    const body = (await res.json()) as { currency: string };
    expect(body.currency).toBe('EUR');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserCashbackByMerchantHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(500);
  });
});
