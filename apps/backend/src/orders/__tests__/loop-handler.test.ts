import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import type * as SchemaModule from '../../db/schema.js';

vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  process.env['LOOP_STELLAR_DEPOSIT_ADDRESS'] =
    'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
});

const createOrderMock = vi.fn();
const getMerchantsMock = vi.fn();

vi.mock('../repo.js', () => ({
  createOrder: (args: unknown) => createOrderMock(args),
}));
vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => getMerchantsMock(),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// Mock the db client — the handler only uses it for the credit
// balance lookup. Chain .select().from().where() resolves to the
// rows we've stashed in `balanceState.rows` for the current test.
const { dbChain, balanceState } = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(async () => state.rows);
  return { dbChain: chain, balanceState: state };
});
vi.mock('../../db/client.js', () => ({ db: dbChain }));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    userCredits: {
      userId: 'userId',
      currency: 'currency',
      balanceMinor: 'balanceMinor',
    },
  };
});

import { loopCreateOrderHandler } from '../loop-handler.js';

interface FakeCtx {
  store: Map<string, unknown>;
  body: unknown;
  ctx: Context;
}

function makeCtx(opts: { auth?: LoopAuthContext | undefined; body?: unknown }): FakeCtx {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    store,
    body: opts.body,
    ctx: {
      req: {
        json: async () => {
          if (opts.body === '__throw__') throw new Error('bad json');
          return opts.body;
        },
      },
      get: (k: string) => store.get(k),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

beforeEach(() => {
  createOrderMock.mockReset();
  getMerchantsMock.mockReset();
  balanceState.rows = [];
  for (const fn of Object.values(dbChain)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
  getMerchantsMock.mockReturnValue({
    merchantsById: new Map([['m1', { id: 'm1', name: 'Target', enabled: true }]]),
  });
  createOrderMock.mockResolvedValue({
    id: 'order-uuid',
    userId: 'user-uuid',
    merchantId: 'm1',
    faceValueMinor: 10_000n,
    currency: 'GBP',
    paymentMethod: 'xlm',
    paymentMemo: 'MEMO-ABCDEFGHIJKLMNOP',
  });
  balanceState.rows = [];
});

describe('loopCreateOrderHandler', () => {
  it('401 when auth is missing or not Loop-kind', async () => {
    const { ctx } = makeCtx({ body: {} });
    expect((await loopCreateOrderHandler(ctx)).status).toBe(401);

    const { ctx: ctx2 } = makeCtx({
      auth: { kind: 'ctx', bearerToken: 'ctx' },
      body: {},
    });
    expect((await loopCreateOrderHandler(ctx2)).status).toBe(401);
  });

  it('400 on invalid body', async () => {
    const { ctx } = makeCtx({ auth: LOOP_AUTH, body: { merchantId: 'm1' } });
    expect((await loopCreateOrderHandler(ctx)).status).toBe(400);
  });

  it('400 when merchant is unknown or disabled', async () => {
    getMerchantsMock.mockReturnValue({ merchantsById: new Map() });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'missing',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    expect((await loopCreateOrderHandler(ctx)).status).toBe(400);
  });

  it('creates an xlm order and returns the deposit address + memo', async () => {
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'xlm',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orderId: string;
      payment: { method: string; memo: string; stellarAddress: string; amountMinor: string };
    };
    expect(body.orderId).toBe('order-uuid');
    expect(body.payment.method).toBe('xlm');
    expect(body.payment.memo).toBe('MEMO-ABCDEFGHIJKLMNOP');
    expect(body.payment.stellarAddress).toMatch(/^G[A-Z2-7]{55}$/);
    expect(body.payment.amountMinor).toBe('10000');
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-uuid',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'xlm',
      }),
    );
  });

  it('upper-cases the currency before passing to the repo', async () => {
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'gbp',
        paymentMethod: 'xlm',
      },
    });
    await loopCreateOrderHandler(ctx);
    expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ currency: 'GBP' }));
  });

  it('credit path — rejects with 400 when balance is insufficient', async () => {
    balanceState.rows = [{ balance: '500' }];
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'credit',
      paymentMemo: null,
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'credit',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INSUFFICIENT_CREDIT');
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('credit path — creates order when balance covers the amount', async () => {
    balanceState.rows = [{ balance: '20000' }];
    createOrderMock.mockResolvedValue({
      id: 'order-uuid',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'credit',
      paymentMemo: null,
    });
    const { ctx } = makeCtx({
      auth: LOOP_AUTH,
      body: {
        merchantId: 'm1',
        amountMinor: 10_000,
        currency: 'GBP',
        paymentMethod: 'credit',
      },
    });
    const res = await loopCreateOrderHandler(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment: { method: string } };
    expect(body.payment.method).toBe('credit');
  });
});

describe('loopCreateOrderHandler — feature flag off', () => {
  it('returns 404 when LOOP_AUTH_NATIVE_ENABLED is false', async () => {
    const prev = process.env['LOOP_AUTH_NATIVE_ENABLED'];
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'false';
    vi.resetModules();
    const fresh = await import('../loop-handler.js');
    const store = new Map<string, unknown>();
    const ctx = {
      req: { json: async () => ({}) },
      get: (k: string) => store.get(k),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), { status: status ?? 200 }),
    } as unknown as Context;
    const res = await fresh.loopCreateOrderHandler(ctx);
    expect(res.status).toBe(404);
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = prev;
    vi.resetModules();
  });
});
