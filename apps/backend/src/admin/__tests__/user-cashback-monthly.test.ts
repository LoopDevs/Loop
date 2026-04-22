import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

// Two queryables in the handler: existence probe, aggregate. The
// mock returns state.existsRows on the first call and state.aggRows
// on subsequent calls — good enough since the handler only ever
// issues one of each per request.
const { state, executeMock } = vi.hoisted(() => {
  const state = {
    existsRows: [] as Array<Record<string, unknown>>,
    aggRows: [] as unknown,
    throwErr: null as Error | null,
    callCount: 0,
  };
  const executeMock = vi.fn(async () => {
    state.callCount += 1;
    if (state.throwErr !== null) throw state.throwErr;
    return state.callCount === 1 ? state.existsRows : state.aggRows;
  });
  return { state, executeMock };
});

vi.mock('../../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    userId: 'credit_transactions.user_id',
    type: 'credit_transactions.type',
    currency: 'credit_transactions.currency',
    amountMinor: 'credit_transactions.amount_minor',
    createdAt: 'credit_transactions.created_at',
  },
  users: {
    id: 'users.id',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
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

import { adminUserCashbackMonthlyHandler } from '../user-cashback-monthly.js';

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeCtx(params: Record<string, string | undefined> = {}): Context {
  return {
    req: { param: (k: string) => params[k] },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.existsRows = [{ id: VALID_UUID }];
  state.aggRows = [];
  state.throwErr = null;
  state.callCount = 0;
  executeMock.mockClear();
});

describe('adminUserCashbackMonthlyHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserCashbackMonthlyHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('404 when the userId does not resolve to a users row', async () => {
    state.existsRows = [];
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(404);
  });

  it('200 with empty entries for an existing user with no cashback in the window', async () => {
    state.aggRows = [];
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; entries: unknown[] };
    expect(body.userId).toBe(VALID_UUID);
    expect(body.entries).toEqual([]);
  });

  it('maps rows into (month, currency, cashbackMinor) entries', async () => {
    state.aggRows = [
      { month: '2026-03-01 00:00:00+00', currency: 'GBP', cashback_minor: '4500' },
      { month: '2026-04-01 00:00:00+00', currency: 'USD', cashback_minor: 12000n },
    ];
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as {
      entries: Array<{ month: string; currency: string; cashbackMinor: string }>;
    };
    expect(body.entries).toEqual([
      { month: '2026-03', currency: 'GBP', cashbackMinor: '4500' },
      { month: '2026-04', currency: 'USD', cashbackMinor: '12000' },
    ]);
  });

  it('preserves bigint precision past 2^53', async () => {
    state.aggRows = [
      {
        month: '2026-04-01 00:00:00+00',
        currency: 'GBP',
        cashback_minor: 9007199254740992n + 19n,
      },
    ];
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: VALID_UUID }));
    const body = (await res.json()) as { entries: Array<{ cashbackMinor: string }> };
    expect(body.entries[0]?.cashbackMinor).toBe('9007199254741011');
  });

  it('handles the { rows } envelope shape on both queries', async () => {
    state.existsRows = { rows: [{ id: VALID_UUID }] } as unknown as Array<Record<string, unknown>>;
    state.aggRows = {
      rows: [{ month: '2026-04-01 00:00:00+00', currency: 'USD', cashback_minor: '100' }],
    };
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('500 when the db throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserCashbackMonthlyHandler(makeCtx({ userId: VALID_UUID }));
    expect(res.status).toBe(500);
  });
});
