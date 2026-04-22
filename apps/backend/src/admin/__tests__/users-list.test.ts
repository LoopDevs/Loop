import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  whereConds: null as unknown,
  limitVal: 0,
}));

const limitMock = vi.fn(async (n: number) => {
  state.limitVal = n;
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn((cond: unknown) => {
  state.whereConds = cond;
  return { orderBy: orderByMock, limit: limitMock };
});
const fromMock = vi.fn(() => ({ where: whereMock, orderBy: orderByMock, limit: limitMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: { select: () => selectMock() },
}));

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    isAdmin: 'users.is_admin',
    homeCurrency: 'users.home_currency',
    createdAt: 'users.created_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    desc: (col: unknown) => ({ __desc: true, col }),
    lt: (col: unknown, value: unknown) => ({ __lt: true, col, value }),
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      { raw: (s: string) => ({ raw: s }) },
    ),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminListUsersHandler } from '../users-list.js';

function makeCtx(query: Record<string, string> = {}): Context {
  return {
    req: {
      query: (k: string) => query[k],
      param: (_k: string) => undefined,
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
  state.whereConds = null;
  state.limitVal = 0;
  limitMock.mockClear();
  orderByMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminListUsersHandler', () => {
  it('returns empty list when no users match', async () => {
    const res = await adminListUsersHandler(makeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
  });

  it('serialises Date createdAt to ISO and preserves booleans', async () => {
    state.rows = [
      {
        id: '11111111-2222-3333-4444-555555555555',
        email: 'a@b.com',
        isAdmin: true,
        homeCurrency: 'GBP',
        createdAt: new Date('2026-04-21T12:00:00Z'),
      },
      {
        id: '99999999-8888-7777-6666-555555555555',
        email: 'c@d.com',
        isAdmin: false,
        homeCurrency: 'USD',
        createdAt: new Date('2026-04-20T12:00:00Z'),
      },
    ];
    const res = await adminListUsersHandler(makeCtx());
    const body = (await res.json()) as {
      users: Array<Record<string, unknown>>;
    };
    expect(body.users).toHaveLength(2);
    expect(body.users[0]).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      email: 'a@b.com',
      isAdmin: true,
      homeCurrency: 'GBP',
      createdAt: '2026-04-21T12:00:00.000Z',
    });
    expect(body.users[1]!['isAdmin']).toBe(false);
  });

  it('applies q filter through a WHERE clause', async () => {
    await adminListUsersHandler(makeCtx({ q: 'loop' }));
    expect(whereMock).toHaveBeenCalled();
  });

  it('400 on q over 254 chars', async () => {
    const res = await adminListUsersHandler(makeCtx({ q: 'x'.repeat(255) }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 on malformed before', async () => {
    const res = await adminListUsersHandler(makeCtx({ before: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('clamps limit — huge values cap at 100, bad values fall back to 20', async () => {
    await adminListUsersHandler(makeCtx({ limit: '999' }));
    expect(state.limitVal).toBe(100);
    await adminListUsersHandler(makeCtx({ limit: 'nope' }));
    expect(state.limitVal).toBe(20);
    await adminListUsersHandler(makeCtx({ limit: '0' }));
    expect(state.limitVal).toBe(1);
  });

  it('stacks q + before into a single AND predicate', async () => {
    await adminListUsersHandler(makeCtx({ q: 'loop', before: '2026-04-20T00:00:00Z' }));
    const cond = state.whereConds as { __and?: true; conds?: unknown[] };
    expect(cond['__and']).toBe(true);
    expect(cond['conds']).toHaveLength(2);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminListUsersHandler(makeCtx());
    expect(res.status).toBe(500);
  });
});
