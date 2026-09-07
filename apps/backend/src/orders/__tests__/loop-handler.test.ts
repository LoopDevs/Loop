/**
 * `POST /api/orders/loop` create-handler tests (ADR 052). ctx is the
 * payment processor — the handler's job is gates → local mirror row →
 * CTX create act-as → relay payment instructions. These pin:
 *
 *   - the gate ladder (flag 404, auth 401, X-Client-Id 400,
 *     cryptoCurrency allowlist 400, face-value cap,
 *     merchant/denomination validation)
 *   - the CTX call shape (act-as headers + platform client id,
 *     operatorReference = the local row id, major-unit fiatAmount)
 *   - CTX failure mapping (400 pass-through class, 5xx/transport →
 *     503 + mirror row rejected)
 *   - the idempotent replay short-circuit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/require-auth.js';

vi.hoisted(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  process.env['LOOP_JWT_SIGNING_KEY'] ??= 'unit-test-loop-jwt-signing-key-32ch!';
  process.env['LOOP_CTX_PAYMENT_CURRENCIES'] = 'XLM,DASH';
});

vi.mock('../../env.js', () => ({
  get env() {
    return {
      LOOP_AUTH_NATIVE_ENABLED: process.env['LOOP_AUTH_NATIVE_ENABLED'] === 'true',
      LOOP_CTX_PAYMENT_CURRENCIES: process.env['LOOP_CTX_PAYMENT_CURRENCIES'],
      GIFT_CARD_API_KEY: 'k',
      GIFT_CARD_API_SECRET: 's',
      CTX_CLIENT_ID_WEB: 'loopweb',
      GIFT_CARD_API_BASE_URL: 'https://ctx.test',
    };
  },
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const {
  merchantsState,
  usersState,
  repoState,
  ctxFetchMock,
  ctxOrderState,
  transitionsCalls,
  notifyCreatedMock,
} = vi.hoisted(() => ({
  merchantsState: {
    map: new Map<string, { id: string; name: string; enabled: boolean; denominations?: unknown }>(),
  },
  usersState: { ctxUserId: 'ctx-u-1' as string | null },
  repoState: {
    created: undefined as Record<string, unknown> | undefined,
    priorByKey: null as Record<string, unknown> | null,
  },
  ctxFetchMock: vi.fn(),
  ctxOrderState: {
    operatorCard: null as unknown,
    payment: null as unknown,
    profitShareBp: 5000 as number | null,
  },
  transitionsCalls: { rejected: [] as Array<[string, string | null]> },
  notifyCreatedMock: vi.fn(),
}));

vi.mock('../../merchants/sync.js', () => ({
  getMerchants: () => ({ merchantsById: merchantsState.map }),
}));
vi.mock('../../db/users.js', () => ({
  getUserCtxUserId: vi.fn(async () => usersState.ctxUserId),
  getUserById: vi.fn(async () => ({ id: 'user-uuid', email: 'a@b.com' })),
}));
vi.mock('../../ctx/user-provisioning.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    provisionCtxUser: vi.fn(async () => undefined),
    ctxActAsHeaders: (ctxUserId: string | null, clientId?: string) =>
      ctxUserId === null
        ? null
        : {
            'X-Api-Key': 'k',
            'X-Api-Secret': 's',
            'X-User-Id': ctxUserId,
            'X-Client-Id': clientId ?? 'loopweb',
          },
  };
});
vi.mock('../../ctx/api-fetch.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    ctxFetch: (url: string, init?: RequestInit) => ctxFetchMock(url, init),
  };
});
vi.mock('../repo.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    createOrder: vi.fn(async (args: Record<string, unknown>) => {
      repoState.created = args;
      return {
        id: 'o-local-1',
        userId: args['userId'],
        merchantId: args['merchantId'],
        faceValueMinor: args['faceValueMinor'],
        currency: args['currency'],
        chargeMinor: args['faceValueMinor'],
        chargeCurrency: args['currency'],
        userCashbackMinor: 0n,
        expectedCommissionMinor: null,
        ctxOrderId: null,
        ctxPaymentId: null,
        paymentCryptoCurrency: args['paymentCryptoCurrency'],
        state: 'unpaid',
        createdAt: new Date(),
      };
    }),
    recordCtxCreate: vi.fn(async () => undefined),
    recordOrderEconomics: vi.fn(async () => undefined),
    findOrderByIdempotencyKey: vi.fn(async () => repoState.priorByKey),
  };
});
vi.mock('../transitions.js', () => ({
  markOrderRejected: vi.fn(async (id: string, reason: string | null) => {
    transitionsCalls.rejected.push([id, reason]);
    return { id };
  }),
}));
vi.mock('../ctx-order.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCtxCardAsOperator: vi.fn(async () => ctxOrderState.operatorCard),
    fetchCtxPayment: vi.fn(async () => ctxOrderState.payment),
    operatorProfitShareBp: vi.fn(async () => ctxOrderState.profitShareBp),
  };
});
vi.mock('../../discord.js', () => ({
  notifyCtxSchemaDrift: vi.fn(),
  notifyOrderCreated: (args: unknown) => notifyCreatedMock(args),
}));

import { loopCreateOrderHandler } from '../loop-handler.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

function makeCtx(opts: {
  auth?: LoopAuthContext;
  clientId?: string;
  body?: unknown;
  idempotencyKey?: string;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  if (opts.clientId !== undefined) store.set('clientId', opts.clientId);
  return {
    req: {
      json: async () => opts.body,
      header: (k: string) =>
        k.toLowerCase() === 'idempotency-key' ? opts.idempotencyKey : undefined,
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

const GOOD_BODY = {
  merchantId: 'amazon',
  amountMinor: 2500,
  currency: 'usd',
  cryptoCurrency: 'xlm',
};

function ctx201(body?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: 'ctx-card-1',
      paymentId: 'ctx-pay-1',
      displayStatus: 'unpaid',
      paymentStatus: 'unpaid',
      paymentFiatAmount: '24.00',
      paymentFiatCurrency: 'USD',
      paymentCryptoAmount: '150.5000000',
      paymentCryptoCurrency: 'XLM',
      paymentCryptoAddress: 'GCTXADDR',
      paymentUrls: { XLM: 'web+stellar:pay?destination=GCTXADDR' },
      ...body,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'true';
  merchantsState.map = new Map([['amazon', { id: 'amazon', name: 'Amazon', enabled: true }]]);
  usersState.ctxUserId = 'ctx-u-1';
  repoState.created = undefined;
  repoState.priorByKey = null;
  ctxFetchMock.mockReset();
  ctxFetchMock.mockResolvedValue(ctx201());
  ctxOrderState.operatorCard = null;
  ctxOrderState.payment = {
    id: 'ctx-pay-1',
    status: 'pending',
    expires: '2026-08-01T00:10:00.000Z',
  };
  transitionsCalls.rejected = [];
  notifyCreatedMock.mockReset();
});

describe('gate ladder', () => {
  it('404s when LOOP_AUTH_NATIVE_ENABLED is off', async () => {
    process.env['LOOP_AUTH_NATIVE_ENABLED'] = 'false';
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    expect(res.status).toBe(404);
  });

  it('401s without a loop auth context', async () => {
    const res = await loopCreateOrderHandler(makeCtx({ clientId: 'loopweb', body: GOOD_BODY }));
    expect(res.status).toBe(401);
  });

  it('400s without a trusted X-Client-Id — never a silent default', async () => {
    const res = await loopCreateOrderHandler(makeCtx({ auth: LOOP_AUTH, body: GOOD_BODY }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('X-Client-Id');
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('400s on a cryptoCurrency outside the allowlist', async () => {
    const res = await loopCreateOrderHandler(
      makeCtx({
        auth: LOOP_AUTH,
        clientId: 'loopweb',
        body: { ...GOOD_BODY, cryptoCurrency: 'BTC' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on an unknown merchant', async () => {
    merchantsState.map = new Map();
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    expect(res.status).toBe(400);
  });

  it('503s when the CTX customer mapping cannot be resolved', async () => {
    usersState.ctxUserId = null;
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    expect(res.status).toBe(503);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });
});

describe('the CTX create call', () => {
  it('creates the local row first and stamps its id as operatorReference', async () => {
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopios', body: GOOD_BODY }),
    );
    expect(res.status).toBe(201);
    expect(repoState.created).toMatchObject({
      userId: 'user-uuid',
      merchantId: 'amazon',
      faceValueMinor: 2500n,
      currency: 'USD',
      paymentCryptoCurrency: 'XLM',
    });
    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/gift-cards');
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      cryptoCurrency: 'XLM',
      fiatCurrency: 'USD',
      fiatAmount: '25.00',
      merchantId: 'amazon',
      operatorReference: 'o-local-1',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['X-User-Id']).toBe('ctx-u-1');
    expect(headers['X-Client-Id']).toBe('loopios');
  });

  it('relays CTX payment instructions in the response', async () => {
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    const body = (await res.json()) as {
      orderId: string;
      state: string;
      payment: Record<string, unknown>;
    };
    expect(body.orderId).toBe('o-local-1');
    expect(body.state).toBe('unpaid');
    expect(body.payment).toMatchObject({
      ctxPaymentId: 'ctx-pay-1',
      cryptoCurrency: 'XLM',
      cryptoAmount: '150.5000000',
      address: 'GCTXADDR',
      amountMinor: '2400',
      currency: 'USD',
      expiresAt: '2026-08-01T00:10:00.000Z',
    });
    expect(notifyCreatedMock).toHaveBeenCalledTimes(1);
  });

  it('maps a CTX 400 to a client validation error and rejects the mirror row', async () => {
    ctxFetchMock.mockResolvedValue(
      new Response('{"error":"denomination invalid"}', { status: 400 }),
    );
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    expect(res.status).toBe(400);
    expect(transitionsCalls.rejected).toEqual([['o-local-1', 'supplier rejected create (400)']]);
  });

  it('maps CTX transport failure to 503 and rejects the mirror row', async () => {
    ctxFetchMock.mockRejectedValue(new Error('socket hang up'));
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    expect(res.status).toBe(503);
    expect(transitionsCalls.rejected).toHaveLength(1);
  });

  it('maps CTX schema drift to 503 and rejects the mirror row', async () => {
    ctxFetchMock.mockResolvedValue(
      new Response('{"unexpected":"shape"}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY }),
    );
    expect(res.status).toBe(503);
    expect(transitionsCalls.rejected).toEqual([['o-local-1', 'supplier response schema drift']]);
  });
});

describe('idempotency', () => {
  it('replays the prior order without touching CTX create', async () => {
    repoState.priorByKey = {
      id: 'o-prior',
      state: 'unpaid',
      ctxOrderId: 'ctx-prior',
      ctxPaymentId: 'pay-prior',
      chargeMinor: 2400n,
      chargeCurrency: 'USD',
      paymentCryptoCurrency: 'XLM',
    };
    ctxOrderState.operatorCard = {
      id: 'ctx-prior',
      displayStatus: 'unpaid',
      paymentId: 'pay-prior',
      paymentFiatAmount: '24.00',
      paymentFiatCurrency: 'USD',
      paymentUrls: {},
    };
    const res = await loopCreateOrderHandler(
      makeCtx({
        auth: LOOP_AUTH,
        clientId: 'loopweb',
        body: GOOD_BODY,
        idempotencyKey: 'k'.repeat(20),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orderId: string };
    expect(body.orderId).toBe('o-prior');
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed Idempotency-Key length', async () => {
    const res = await loopCreateOrderHandler(
      makeCtx({ auth: LOOP_AUTH, clientId: 'loopweb', body: GOOD_BODY, idempotencyKey: 'short' }),
    );
    expect(res.status).toBe(400);
  });
});
