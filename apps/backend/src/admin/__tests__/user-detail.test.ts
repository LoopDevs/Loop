import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

const limitMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const whereMock = vi.fn(() => ({ limit: limitMock }));
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
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminGetUserHandler } from '../user-detail.js';

function makeCtx(params: Record<string, string> = {}): Context {
  return {
    req: {
      query: (_k: string) => undefined,
      param: (k: string) => params[k],
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
  limitMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminGetUserHandler', () => {
  it('400 when userId is missing', async () => {
    const res = await adminGetUserHandler(makeCtx({}));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminGetUserHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('404 when the user is not found', async () => {
    state.rows = [];
    const res = await adminGetUserHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(404);
  });

  it('returns the user view on hit', async () => {
    state.rows = [
      {
        id: validUserId,
        email: 'a@b.com',
        isAdmin: true,
        homeCurrency: 'GBP',
        stellarAddress: 'G' + 'A'.repeat(55),
        ctxUserId: 'ctx-42',
        createdAt: new Date('2026-01-10T09:00:00Z'),
        updatedAt: new Date('2026-04-20T14:00:00Z'),
      },
    ];
    const res = await adminGetUserHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: validUserId,
      email: 'a@b.com',
      isAdmin: true,
      homeCurrency: 'GBP',
      stellarAddress: 'G' + 'A'.repeat(55),
      ctxUserId: 'ctx-42',
      createdAt: '2026-01-10T09:00:00.000Z',
      updatedAt: '2026-04-20T14:00:00.000Z',
    });
  });

  it('serialises null CTX + Stellar fields through as null', async () => {
    state.rows = [
      {
        id: validUserId,
        email: 'a@b.com',
        isAdmin: false,
        homeCurrency: 'USD',
        stellarAddress: null,
        ctxUserId: null,
        createdAt: new Date('2026-04-20T10:00:00Z'),
        updatedAt: new Date('2026-04-20T10:00:00Z'),
      },
    ];
    const res = await adminGetUserHandler(makeCtx({ userId: validUserId }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['stellarAddress']).toBeNull();
    expect(body['ctxUserId']).toBeNull();
    expect(body['isAdmin']).toBe(false);
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminGetUserHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(500);
  });
});
