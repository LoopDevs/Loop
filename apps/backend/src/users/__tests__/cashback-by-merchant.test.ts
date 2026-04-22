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
    referenceType: 'credit_transactions.reference_type',
    referenceId: 'credit_transactions.reference_id',
    createdAt: 'credit_transactions.created_at',
  },
  orders: {
    id: 'orders.id',
    merchantId: 'orders.merchant_id',
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

import { getCashbackByMerchantHandler } from '../cashback-by-merchant.js';

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

function makeCtx(auth: LoopAuthContext | undefined, query: Record<string, string> = {}): Context {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  return {
    req: {
      query: (k: string) => query[k],
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

describe('getCashbackByMerchantHandler', () => {
  it('401 when there is no auth context', async () => {
    const res = await getCashbackByMerchantHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('returns empty rows when the user has no cashback in the window', async () => {
    state.rows = [];
    const res = await getCashbackByMerchantHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      since: string;
      rows: unknown[];
    };
    expect(body.currency).toBe('GBP');
    expect(body.rows).toEqual([]);
    expect(typeof body.since).toBe('string');
  });

  it('normalises bigint / string / number counts + ISO-serialises lastEarnedAt', async () => {
    state.rows = [
      {
        merchant_id: 'amazon_us',
        cashback_minor: 12_500n,
        order_count: '5',
        last_earned_at: new Date('2026-04-22T10:00:00Z'),
      },
      {
        merchant_id: 'apple',
        cashback_minor: '4200',
        order_count: 2,
        last_earned_at: '2026-04-15T09:00:00Z',
      },
    ];
    const res = await getCashbackByMerchantHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      merchantId: 'amazon_us',
      cashbackMinor: '12500',
      orderCount: 5,
      lastEarnedAt: '2026-04-22T10:00:00.000Z',
    });
    expect(body.rows[1]!['lastEarnedAt']).toBe('2026-04-15T09:00:00.000Z');
  });

  it('accepts an ISO-8601 ?since and echoes it back', async () => {
    const res = await getCashbackByMerchantHandler(
      makeCtx(LOOP_AUTH, { since: '2026-04-01T00:00:00Z' }),
    );
    const body = (await res.json()) as { since: string };
    expect(body.since).toBe('2026-04-01T00:00:00.000Z');
  });

  it('400 on malformed ?since', async () => {
    const res = await getCashbackByMerchantHandler(makeCtx(LOOP_AUTH, { since: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('400 when since is more than 366 days ago', async () => {
    const tooOld = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const res = await getCashbackByMerchantHandler(makeCtx(LOOP_AUTH, { since: tooOld }));
    expect(res.status).toBe(400);
  });

  it('tolerates the { rows } envelope node-postgres returns', async () => {
    state.rows = {
      rows: [
        {
          merchant_id: 'solo_merchant',
          cashback_minor: '999',
          order_count: 1,
          last_earned_at: '2026-04-22T00:00:00Z',
        },
      ],
    } as unknown as Array<Record<string, unknown>>;
    const res = await getCashbackByMerchantHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!['merchantId']).toBe('solo_merchant');
  });

  it('500 when the aggregate throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await getCashbackByMerchantHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(500);
  });
});
