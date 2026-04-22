import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  throwErr: null as Error | null,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => {
      if (state.throwErr !== null) throw state.throwErr;
      return state.rows;
    }),
  },
}));

vi.mock('../../db/schema.js', () => ({
  creditTransactions: {
    userId: 'credit_transactions.user_id',
    type: 'credit_transactions.type',
    amountMinor: 'credit_transactions.amount_minor',
    currency: 'credit_transactions.currency',
    createdAt: 'credit_transactions.created_at',
  },
}));

const { userState } = vi.hoisted(() => ({
  userState: {
    byId: null as unknown,
    upsertThrow: null as Error | null,
  },
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.byId),
  upsertUserFromCtx: vi.fn(async () => {
    if (userState.upsertThrow !== null) throw userState.upsertThrow;
    return userState.byId;
  }),
}));

const { jwtState } = vi.hoisted(() => ({
  jwtState: { claims: null as Record<string, unknown> | null },
}));
vi.mock('../../auth/jwt.js', () => ({
  decodeJwtPayload: () => jwtState.claims,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getCashbackMonthlyHandler } from '../cashback-monthly.js';

const baseUser = {
  id: 'user-uuid',
  email: 'a@b.com',
  isAdmin: false,
  homeCurrency: 'GBP',
  stellarAddress: null,
  ctxUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-jwt',
};

function makeCtx(auth: LoopAuthContext | undefined): Context {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  return {
    req: {
      query: (_k: string) => undefined,
      param: (_k: string) => undefined,
    },
    get: (k: string) => store.get(k),
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
  userState.byId = baseUser;
  userState.upsertThrow = null;
  jwtState.claims = null;
});

describe('getCashbackMonthlyHandler', () => {
  it('401 when no auth context is attached', async () => {
    const res = await getCashbackMonthlyHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('returns an empty entries list when the user has no cashback', async () => {
    state.rows = [];
    const res = await getCashbackMonthlyHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('formats DB rows as YYYY-MM + bigint-string amounts', async () => {
    state.rows = [
      {
        month: new Date(Date.UTC(2026, 1, 1)), // Feb 2026
        currency: 'GBP',
        cashback_minor: 2500n,
      },
      {
        month: new Date(Date.UTC(2026, 2, 1)), // Mar 2026
        currency: 'GBP',
        cashback_minor: '1800',
      },
      {
        month: new Date(Date.UTC(2026, 3, 1)), // Apr 2026
        currency: 'GBP',
        cashback_minor: 900,
      },
    ];
    const res = await getCashbackMonthlyHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ month: string; currency: string; cashbackMinor: string }>;
    };
    expect(body.entries).toEqual([
      { month: '2026-02', currency: 'GBP', cashbackMinor: '2500' },
      { month: '2026-03', currency: 'GBP', cashbackMinor: '1800' },
      { month: '2026-04', currency: 'GBP', cashbackMinor: '900' },
    ]);
  });

  it('returns both currency entries for a multi-currency user', async () => {
    state.rows = [
      {
        month: new Date(Date.UTC(2026, 3, 1)),
        currency: 'GBP',
        cashback_minor: 2500n,
      },
      {
        month: new Date(Date.UTC(2026, 3, 1)),
        currency: 'USD',
        cashback_minor: 1200n,
      },
    ];
    const res = await getCashbackMonthlyHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as {
      entries: Array<{ month: string; currency: string }>;
    };
    expect(body.entries).toHaveLength(2);
    const pairs = body.entries.map((e) => `${e.month}-${e.currency}`).sort();
    expect(pairs).toEqual(['2026-04-GBP', '2026-04-USD']);
  });

  it('handles postgres-js { rows: [...] } return shape', async () => {
    // Override the outer hoisted mock for this one case by making
    // db.execute return an object rather than an array. The handler
    // unwraps both shapes.
    const pgShape = {
      rows: [{ month: '2026-04-01T00:00:00Z', currency: 'EUR', cashback_minor: 500n }],
    };
    state.rows = pgShape as unknown as typeof state.rows;
    const res = await getCashbackMonthlyHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('500 when the query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await getCashbackMonthlyHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(500);
  });
});
