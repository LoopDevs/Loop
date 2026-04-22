import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  limitArg: 0,
}));

const limitMock = vi.fn(async (n: number) => {
  state.limitArg = n;
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    userId: 'credit_transactions.user_id',
    createdAt: 'credit_transactions.created_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    asc: (col: unknown) => ({ __asc: true, col }),
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

import { adminUserCreditTransactionsCsvHandler } from '../user-credit-transactions-csv.js';

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

const baseRow = {
  id: 'c-1',
  type: 'cashback',
  amountMinor: 5_000n,
  currency: 'GBP',
  referenceType: 'order',
  referenceId: 'o-1',
  createdAt: new Date('2026-04-20T10:00:00Z'),
};

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
  state.limitArg = 0;
  limitMock.mockClear();
  orderByMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminUserCreditTransactionsCsvHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('returns just the header row when the window is empty', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="credit-transactions-aaaaaaaa-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await res.text();
    expect(body.startsWith('id,type,amount_minor')).toBe(true);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('emits one row per entry with bigint + ISO coercion', async () => {
    state.rows = [
      baseRow,
      {
        ...baseRow,
        id: 'c-2',
        type: 'withdrawal',
        amountMinor: -1_000n,
        referenceType: null,
        referenceId: null,
      },
    ];
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: validUserId }));
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('c-1');
    expect(lines[1]).toContain('5000');
    expect(lines[1]).toContain('cashback');
    expect(lines[1]).toContain('2026-04-20T10:00:00.000Z');
    expect(lines[2]).toContain('-1000');
    expect(lines[2]).toContain('withdrawal');
  });

  it('RFC 4180 — escapes quotes, commas, and CRLF in referenceId', async () => {
    state.rows = [
      {
        ...baseRow,
        referenceId: 'boom: "quoted", comma, and CRLF\r\nhere',
      },
    ];
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: validUserId }));
    const body = await res.text();
    expect(body).toContain('"boom: ""quoted"", comma, and CRLF\r\nhere"');
  });

  it('truncates with __TRUNCATED__ sentinel past 10 000 rows', async () => {
    state.rows = Array.from({ length: 10_001 }, (_, i) => ({
      ...baseRow,
      id: `c-${i}`,
    }));
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: validUserId }));
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10_002);
    expect(lines[lines.length - 1]).toBe('__TRUNCATED__');
  });

  it('accepts ?since and echoes the date in the filename', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(
      makeCtx({ userId: validUserId }, { since: '2026-04-01T00:00:00Z' }),
    );
    expect(res.headers.get('content-disposition')).toContain(
      `credit-transactions-${validUserId.slice(0, 8)}-2026-04-01.csv`,
    );
  });

  it('400 on malformed ?since', async () => {
    const res = await adminUserCreditTransactionsCsvHandler(
      makeCtx({ userId: validUserId }, { since: 'not-a-date' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when ?since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminUserCreditTransactionsCsvHandler(
      makeCtx({ userId: validUserId }, { since: tooOld }),
    );
    expect(res.status).toBe(400);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(500);
  });

  it('asks the repo for ROW_CAP+1 rows so truncation is detectable', async () => {
    await adminUserCreditTransactionsCsvHandler(makeCtx({ userId: validUserId }));
    expect(state.limitArg).toBe(10_001);
  });
});
