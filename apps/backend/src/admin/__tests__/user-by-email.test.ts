import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  capturedWhere: null as unknown,
}));

const limitMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const whereMock = vi.fn((condition: unknown) => {
  state.capturedWhere = condition;
  return { limit: limitMock };
});
const fromMock = vi.fn(() => ({ where: whereMock }));
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
    stellarAddress: 'users.stellar_address',
    ctxUserId: 'users.ctx_user_id',
    createdAt: 'users.created_at',
    updatedAt: 'users.updated_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: true,
      strings,
      values,
    }),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminUserByEmailHandler } from '../user-by-email.js';

function makeCtx(query: Record<string, string | undefined> = {}): Context {
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

const validUserId = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  state.rows = [];
  state.throwErr = null;
  state.capturedWhere = null;
  limitMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminUserByEmailHandler', () => {
  it('400 when email query param is missing', async () => {
    const res = await adminUserByEmailHandler(makeCtx({}));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when email is empty', async () => {
    const res = await adminUserByEmailHandler(makeCtx({ email: '' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when email is longer than 254 chars', async () => {
    const oversized = `${'a'.repeat(260)}@b.com`;
    expect(oversized.length).toBeGreaterThan(254);
    const res = await adminUserByEmailHandler(makeCtx({ email: oversized }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each(['no-at-sign', 'has spaces@b.com', 'trailing@', '@leading.com', 'nodot@bcom'])(
    '400 on malformed address: %s',
    async (bad) => {
      const res = await adminUserByEmailHandler(makeCtx({ email: bad }));
      expect(res.status).toBe(400);
    },
  );

  it('404 when the lookup returns no rows', async () => {
    state.rows = [];
    const res = await adminUserByEmailHandler(makeCtx({ email: 'nobody@loop.test' }));
    expect(res.status).toBe(404);
  });

  it('returns the user on happy-path hit', async () => {
    state.rows = [
      {
        id: validUserId,
        email: 'Alice@Example.COM',
        isAdmin: false,
        homeCurrency: 'GBP',
        stellarAddress: null,
        ctxUserId: null,
        createdAt: new Date('2026-03-10T09:00:00Z'),
        updatedAt: new Date('2026-04-18T12:00:00Z'),
      },
    ];
    const res = await adminUserByEmailHandler(makeCtx({ email: 'Alice@Example.COM' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe(validUserId);
    expect(body['email']).toBe('Alice@Example.COM');
    expect(body['homeCurrency']).toBe('GBP');
  });

  it('normalises the query to lowercase before matching', async () => {
    state.rows = [
      {
        id: validUserId,
        email: 'alice@example.com',
        isAdmin: false,
        homeCurrency: 'USD',
        stellarAddress: null,
        ctxUserId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const res = await adminUserByEmailHandler(makeCtx({ email: 'Alice@Example.COM' }));
    expect(res.status).toBe(200);
    // Captured predicate carries the lowercase normalised form so
    // mixed-case input can't miss the row.
    const where = state.capturedWhere as { value: string } | null;
    expect(where?.value).toBe('alice@example.com');
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserByEmailHandler(makeCtx({ email: 'a@b.com' }));
    expect(res.status).toBe(500);
  });
});
