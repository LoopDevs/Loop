import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
  whereValue: undefined as unknown,
}));

const orderByMock = vi.fn(async () => {
  if (state.throwErr !== null) throw state.throwErr;
  return state.rows;
});
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => selectMock(),
  },
}));

vi.mock('../../db/schema.js', () => ({
  userCredits: {
    userId: 'user_credits.user_id',
    currency: 'user_credits.currency',
    balanceMinor: 'user_credits.balance_minor',
    updatedAt: 'user_credits.updated_at',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = (await vi.importActual('drizzle-orm')) as Record<string, unknown>;
  return {
    ...actual,
    eq: (_col: unknown, value: unknown) => {
      state.whereValue = value;
      return { __eq: true, value };
    },
    asc: (col: unknown) => ({ __asc: true, col }),
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { adminUserCreditsHandler } from '../user-credits.js';

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
  state.whereValue = undefined;
  orderByMock.mockClear();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

describe('adminUserCreditsHandler', () => {
  it('400 when userId param is missing', async () => {
    const res = await adminUserCreditsHandler(makeCtx({}));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('400 when userId is not a uuid', async () => {
    const res = await adminUserCreditsHandler(makeCtx({ userId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns empty rows when the user has no credit entries', async () => {
    const res = await adminUserCreditsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; rows: unknown[] };
    expect(body).toEqual({ userId: validUserId, rows: [] });
    expect(state.whereValue).toBe(validUserId);
  });

  it('serialises bigint balances as strings and Dates as ISO', async () => {
    state.rows = [
      {
        currency: 'EUR',
        balanceMinor: 12_345n,
        updatedAt: new Date('2026-04-10T09:00:00Z'),
      },
      {
        currency: 'GBP',
        balanceMinor: 890_000n,
        updatedAt: new Date('2026-04-20T14:00:00Z'),
      },
    ];
    const res = await adminUserCreditsHandler(makeCtx({ userId: validUserId }));
    const body = (await res.json()) as {
      userId: string;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      currency: 'EUR',
      balanceMinor: '12345',
      updatedAt: '2026-04-10T09:00:00.000Z',
    });
    expect(body.rows[1]!['balanceMinor']).toBe('890000');
  });

  it('500 when the repo throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await adminUserCreditsHandler(makeCtx({ userId: validUserId }));
    expect(res.status).toBe(500);
  });
});
