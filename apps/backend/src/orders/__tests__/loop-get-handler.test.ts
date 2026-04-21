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

const { orderState } = vi.hoisted(() => {
  const state: { row: unknown } = { row: undefined };
  return { orderState: state };
});

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: async () => [] }),
    })),
    query: {
      orders: {
        findFirst: vi.fn(async () => orderState.row),
      },
    },
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    orders: { id: 'id', userId: 'user_id' },
    userCredits: { userId: 'userId', currency: 'currency', balanceMinor: 'balanceMinor' },
  };
});

import { loopGetOrderHandler } from '../loop-handler.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

function makeCtx(opts: { auth?: LoopAuthContext; param?: string }): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    req: {
      param: (k: string) => (k === 'id' ? opts.param : undefined),
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
  orderState.row = undefined;
});

describe('loopGetOrderHandler', () => {
  it('404 when auth missing', async () => {
    const res = await loopGetOrderHandler(makeCtx({ param: 'x' }));
    expect(res.status).toBe(401);
  });

  it('401 when auth is not loop-kind', async () => {
    const res = await loopGetOrderHandler(
      makeCtx({
        auth: { kind: 'ctx', bearerToken: 'ctx' },
        param: 'x',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('400 when id param is missing', async () => {
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH }));
    expect(res.status).toBe(400);
  });

  it('404 when no matching order exists for this user', async () => {
    orderState.row = undefined;
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'order-1' }));
    expect(res.status).toBe(404);
  });

  it('returns the BigInt-safe view for an owned pending_payment order', async () => {
    orderState.row = {
      id: 'order-1',
      userId: 'user-uuid',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'USD',
      paymentMethod: 'usdc',
      paymentMemo: 'MEMO-ABC',
      userCashbackMinor: 500n,
      ctxOrderId: null,
      state: 'pending_payment',
      failureReason: null,
      createdAt: new Date('2026-04-21T00:00:00Z'),
      paidAt: null,
      fulfilledAt: null,
      failedAt: null,
    };
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'order-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe('order-1');
    expect(body['state']).toBe('pending_payment');
    expect(body['faceValueMinor']).toBe('10000');
    expect(body['userCashbackMinor']).toBe('500');
    expect(body['paymentMemo']).toBe('MEMO-ABC');
    expect(body['stellarAddress']).toMatch(/^G/);
    expect(body['createdAt']).toBe('2026-04-21T00:00:00.000Z');
  });

  it('returns stellarAddress=null for a credit-funded order', async () => {
    orderState.row = {
      id: 'order-2',
      userId: 'user-uuid',
      merchantId: 'm1',
      faceValueMinor: 1_000n,
      currency: 'USD',
      paymentMethod: 'credit',
      paymentMemo: null,
      userCashbackMinor: 0n,
      ctxOrderId: null,
      state: 'paid',
      failureReason: null,
      createdAt: new Date(),
      paidAt: new Date(),
      fulfilledAt: null,
      failedAt: null,
    };
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'order-2' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['paymentMethod']).toBe('credit');
    expect(body['stellarAddress']).toBeNull();
  });

  it('surfaces ctxOrderId + fulfilledAt once fulfilled', async () => {
    orderState.row = {
      id: 'order-3',
      userId: 'user-uuid',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'USD',
      paymentMethod: 'usdc',
      paymentMemo: 'MEMO',
      userCashbackMinor: 500n,
      ctxOrderId: 'ctx-abc',
      state: 'fulfilled',
      failureReason: null,
      createdAt: new Date(),
      paidAt: new Date(),
      fulfilledAt: new Date('2026-04-21T01:00:00Z'),
      failedAt: null,
    };
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'order-3' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['state']).toBe('fulfilled');
    expect(body['ctxOrderId']).toBe('ctx-abc');
    expect(body['fulfilledAt']).toBe('2026-04-21T01:00:00.000Z');
  });
});
