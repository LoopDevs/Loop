import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import type * as SchemaModule from '../../db/schema.js';

vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] =
    'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock('../repo.js', () => ({ createOrder: async () => ({ id: 'unused' }) }));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: new Map() }),
}));

const { dbChain, listState } = vi.hoisted(() => {
  const state: { rows: unknown[]; whereArgs: unknown[] } = { rows: [], whereArgs: [] };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn((arg: unknown) => {
    state.whereArgs.push(arg);
    return chain;
  });
  chain['orderBy'] = vi.fn(() => chain);
  chain['limit'] = vi.fn(async () => state.rows);
  return { dbChain: chain, listState: state };
});

vi.mock('../../db/client.js', () => ({
  db: {
    ...dbChain,
    query: {
      orders: {
        findFirst: vi.fn(async () => undefined),
      },
    },
  },
}));

vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    orders: { id: 'id', userId: 'user_id', createdAt: 'created_at' },
    userCredits: { userId: 'userId', currency: 'currency', balanceMinor: 'balanceMinor' },
  };
});

import { loopListOrdersHandler } from '../loop-handler.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

function makeCtx(opts: { auth?: LoopAuthContext; query?: Record<string, string> }): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  const q = opts.query ?? {};
  return {
    req: {
      query: (k: string) => q[k],
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    userId: 'user-uuid',
    merchantId: 'm1',
    faceValueMinor: 1_000n,
    currency: 'USD',
    paymentMethod: 'usdc',
    paymentMemo: 'MEMO',
    userCashbackMinor: 50n,
    ctxOrderId: null,
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    state: 'pending_payment',
    failureReason: null,
    createdAt: new Date('2026-04-21T12:00:00Z'),
    paidAt: null,
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  listState.rows = [];
  listState.whereArgs = [];
  for (const fn of Object.values(dbChain)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('loopListOrdersHandler', () => {
  it('401 when auth is missing', async () => {
    const res = await loopListOrdersHandler(makeCtx({}));
    expect(res.status).toBe(401);
  });

  it('401 when auth is not loop-kind', async () => {
    const res = await loopListOrdersHandler(makeCtx({ auth: { kind: 'ctx', bearerToken: 'x' } }));
    expect(res.status).toBe(401);
  });

  it('returns the list shape with BigInt-safe fields', async () => {
    listState.rows = [makeRow({ id: 'o-1' }), makeRow({ id: 'o-2' })];
    const res = await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<Record<string, unknown>> };
    expect(body.orders).toHaveLength(2);
    expect(body.orders[0]!['id']).toBe('o-1');
    expect(body.orders[0]!['faceValueMinor']).toBe('1000');
    expect(body.orders[0]!['userCashbackMinor']).toBe('50');
    expect(body.orders[0]!['createdAt']).toBe('2026-04-21T12:00:00.000Z');
  });

  it('empty list is a valid response', async () => {
    listState.rows = [];
    const res = await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH }));
    const body = (await res.json()) as { orders: unknown[] };
    expect(body.orders).toEqual([]);
  });

  it('defaults limit to 50 and clamps to 1–100', async () => {
    await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH }));
    expect(dbChain['limit']!).toHaveBeenLastCalledWith(50);

    await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH, query: { limit: '10' } }));
    expect(dbChain['limit']!).toHaveBeenLastCalledWith(10);

    await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH, query: { limit: '0' } }));
    expect(dbChain['limit']!).toHaveBeenLastCalledWith(1);

    await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH, query: { limit: '99999' } }));
    expect(dbChain['limit']!).toHaveBeenLastCalledWith(100);
  });

  it('400 on malformed before timestamp', async () => {
    const res = await loopListOrdersHandler(
      makeCtx({ auth: LOOP_AUTH, query: { before: 'not-a-date' } }),
    );
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed before timestamp and passes a WHERE', async () => {
    listState.rows = [];
    const res = await loopListOrdersHandler(
      makeCtx({ auth: LOOP_AUTH, query: { before: '2026-04-21T00:00:00Z' } }),
    );
    expect(res.status).toBe(200);
    // Verify the handler reached the .where(...) call with a pagination clause.
    expect(listState.whereArgs.length).toBe(1);
  });
});
