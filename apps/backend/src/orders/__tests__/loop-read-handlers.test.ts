/**
 * Loop order read-handler tests (ADR 052): auth/flag gates, the
 * BigInt-safe `orderToView` shaping (incl. at-rest decryption of the
 * redemption secrets), and the unpaid-order live CTX payment overlay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';

const { configState } = vi.hoisted(() => ({
  configState: { nativeAuthEnabled: true },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: configState.nativeAuthEnabled },
        },
        orders: {
          ...actual.config.orders,
          // CF-25 / X-PRIV-03: fixed, valid 32-byte base64 key so the
          // read handler decrypts on the way out.
          redeem: { encryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' },
        },
      };
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { dbState, ctxState } = vi.hoisted(() => ({
  dbState: {
    row: undefined as unknown,
    listRows: [] as unknown[],
  },
  ctxState: {
    card: null as unknown,
    payment: null as unknown,
    cardThrows: false,
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    collection: vi.fn(() => ({
      findOne: vi.fn(async () => dbState.row ?? null),
      findMany: vi.fn(async () => dbState.listRows),
    })),
  },
}));

vi.mock('../ctx-order.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCtxCardAsOperator: vi.fn(async () => {
      if (ctxState.cardThrows) throw new Error('ctx down');
      return ctxState.card;
    }),
    fetchCtxPayment: vi.fn(async () => ctxState.payment),
  };
});

import { loopGetOrderHandler, loopListOrdersHandler } from '../loop-read-handlers.js';
import { encryptRedeemField, resetRedeemKeyCache } from '../redeem-crypto.js';

const LOOP_AUTH: LoopAuthContext = {
  kind: 'loop',
  userId: 'user-uuid',
  email: 'a@b.com',
  bearerToken: 'loop-access',
};

function makeCtx(opts: {
  auth?: LoopAuthContext;
  param?: string;
  query?: Record<string, string>;
}): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    req: {
      param: (k: string) => (k === 'id' ? opts.param : undefined),
      query: (k: string) => opts.query?.[k],
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function baseRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'o-1',
    userId: 'user-uuid',
    merchantId: 'amazon',
    faceValueMinor: 2500n,
    currency: 'USD',
    chargeMinor: 2400n,
    chargeCurrency: 'USD',
    userCashbackMinor: 100n,
    expectedCommissionMinor: 50n,
    ctxOrderId: 'ctx-1',
    ctxPaymentId: 'pay-1',
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'unpaid',
    failureReason: null,
    idempotencyKey: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.row = undefined;
  dbState.listRows = [];
  ctxState.card = null;
  ctxState.payment = null;
  ctxState.cardThrows = false;
  configState.nativeAuthEnabled = true;
  resetRedeemKeyCache();
});

describe('loopGetOrderHandler', () => {
  it('401s without a loop auth context', async () => {
    const res = await loopGetOrderHandler(makeCtx({ param: 'o-1' }));
    expect(res.status).toBe(401);
  });

  it('404s on a non-owner / missing order', async () => {
    dbState.row = undefined;
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'o-1' }));
    expect(res.status).toBe(404);
  });

  it('overlays live CTX payment instructions for an unpaid order', async () => {
    dbState.row = baseRow();
    ctxState.card = {
      id: 'ctx-1',
      displayStatus: 'unpaid',
      paymentId: 'pay-1',
      paymentFiatAmount: '24.00',
      paymentFiatCurrency: 'USD',
      paymentCryptoAmount: '150.5000000',
      paymentCryptoCurrency: 'XLM',
      paymentCryptoAddress: 'GCTXADDRESS',
      paymentUrls: { XLM: 'web+stellar:pay?destination=GCTXADDRESS' },
    };
    ctxState.payment = { id: 'pay-1', status: 'pending', expires: '2026-08-01T00:10:00.000Z' };
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'o-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment: Record<string, unknown>; state: string };
    expect(body.state).toBe('unpaid');
    expect(body.payment).toMatchObject({
      ctxPaymentId: 'pay-1',
      cryptoCurrency: 'XLM',
      cryptoAmount: '150.5000000',
      address: 'GCTXADDRESS',
      amountMinor: '2400',
      currency: 'USD',
      expiresAt: '2026-08-01T00:10:00.000Z',
    });
  });

  it('serves the view without payment when the live CTX read fails (fail-soft)', async () => {
    dbState.row = baseRow();
    ctxState.cardThrows = true;
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'o-1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment: unknown };
    expect(body.payment).toBeNull();
  });

  it('skips the CTX read entirely for a terminal order and decrypts the redemption', async () => {
    dbState.row = baseRow({
      state: 'fulfilled',
      redeemCode: encryptRedeemField('CODE-XYZ'),
      redeemPin: encryptRedeemField('4321'),
      redeemUrl: 'https://redeem.example/z',
      fulfilledAt: new Date('2026-08-01T01:00:00Z'),
    });
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'o-1' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.redeemCode).toBe('CODE-XYZ');
    expect(body.redeemPin).toBe('4321');
    expect(body.redeemUrl).toBe('https://redeem.example/z');
    expect(body.payment).toBeNull();
  });

  it('serialises BigInt columns as strings', async () => {
    dbState.row = baseRow({ state: 'paid' });
    const res = await loopGetOrderHandler(makeCtx({ auth: LOOP_AUTH, param: 'o-1' }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.faceValueMinor).toBe('2500');
    expect(body.chargeMinor).toBe('2400');
    expect(body.userCashbackMinor).toBe('100');
  });
});

describe('loopListOrdersHandler', () => {
  it('401s without a loop auth context', async () => {
    const res = await loopListOrdersHandler(makeCtx({}));
    expect(res.status).toBe(401);
  });

  it('returns the shaped list without payment overlays', async () => {
    dbState.listRows = [baseRow(), baseRow({ id: 'o-2', state: 'fulfilled' })];
    const res = await loopListOrdersHandler(makeCtx({ auth: LOOP_AUTH }));
    const body = (await res.json()) as { orders: Array<Record<string, unknown>> };
    expect(body.orders).toHaveLength(2);
    expect(body.orders[0]).toMatchObject({ id: 'o-1', payment: null });
  });

  it('400s on a malformed ?before timestamp', async () => {
    const res = await loopListOrdersHandler(
      makeCtx({ auth: LOOP_AUTH, query: { before: 'not-a-date' } }),
    );
    expect(res.status).toBe(400);
  });
});
