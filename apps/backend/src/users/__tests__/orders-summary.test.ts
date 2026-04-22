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
  orders: {
    userId: 'orders.user_id',
    state: 'orders.state',
    chargeMinor: 'orders.charge_minor',
    chargeCurrency: 'orders.charge_currency',
  },
}));

const { userState } = vi.hoisted(() => ({
  userState: {
    byId: null as unknown,
  },
}));

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => userState.byId),
  upsertUserFromCtx: vi.fn(async () => userState.byId),
}));

vi.mock('../../auth/jwt.js', () => ({
  decodeJwtPayload: () => null,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { getUserOrdersSummaryHandler } from '../orders-summary.js';

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
});

describe('getUserOrdersSummaryHandler', () => {
  it('401 when no auth context is attached', async () => {
    const res = await getUserOrdersSummaryHandler(makeCtx(undefined));
    expect(res.status).toBe(401);
  });

  it('returns zeros when the user has no orders', async () => {
    state.rows = [];
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      totalOrders: 0,
      fulfilledCount: 0,
      pendingCount: 0,
      failedCount: 0,
      totalSpentMinor: '0',
    });
  });

  it('returns the 5-number summary from the aggregate row', async () => {
    state.rows = [
      {
        totalOrders: 12,
        fulfilledCount: 7,
        pendingCount: 3,
        failedCount: 2,
        totalSpentMinor: 35000n,
      },
    ];
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      currency: 'GBP',
      totalOrders: 12,
      fulfilledCount: 7,
      pendingCount: 3,
      failedCount: 2,
      totalSpentMinor: '35000',
    });
  });

  it('normalises string / number / bigint amount shapes end-to-end', async () => {
    state.rows = [
      {
        totalOrders: '5',
        fulfilledCount: '3',
        pendingCount: '1',
        failedCount: '1',
        totalSpentMinor: '12500',
      },
    ];
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['totalOrders']).toBe(5);
    expect(body['totalSpentMinor']).toBe('12500');
  });

  it('handles postgres-js { rows: [...] } return shape', async () => {
    state.rows = {
      rows: [
        {
          totalOrders: 1,
          fulfilledCount: 1,
          pendingCount: 0,
          failedCount: 0,
          totalSpentMinor: 10_000n,
        },
      ],
    } as unknown as typeof state.rows;
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    const body = (await res.json()) as { totalOrders: number };
    expect(body.totalOrders).toBe(1);
  });

  it('500 when the query throws', async () => {
    state.throwErr = new Error('db exploded');
    const res = await getUserOrdersSummaryHandler(makeCtx(LOOP_AUTH));
    expect(res.status).toBe(500);
  });
});
