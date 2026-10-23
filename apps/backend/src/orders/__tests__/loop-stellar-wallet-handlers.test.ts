// connected-wallet pay passthrough tests — ADR 052
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Context } from 'hono';
import type { LoopAuthContext } from '../../auth/handler.js';
import type { CtxFetchOptions } from '../../ctx/api-fetch.js';

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
        ctx: { ...actual.config.ctx, baseUrl: 'https://ctx.test' },
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: configState.nativeAuthEnabled },
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

const { dbState, ctxFetchMock } = vi.hoisted(() => ({
  dbState: { row: undefined as unknown },
  ctxFetchMock: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    collection: vi.fn(() => ({
      findOne: vi.fn(async () => dbState.row ?? null),
    })),
  },
}));

vi.mock('../../ctx/api-fetch.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    ctxFetch: (url: string, init?: RequestInit, options?: CtxFetchOptions) =>
      ctxFetchMock(url, init, options),
  };
});

import {
  loopStellarSubmitHandler,
  loopStellarTransactionHandler,
} from '../loop-stellar-wallet-handlers.js';

const LOOP_AUTH: LoopAuthContext = {
  userId: 'user-uuid',
  email: 'a@b.com',
};

const SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function makeCtx(opts: { auth?: LoopAuthContext; param?: string; body?: unknown }): Context {
  const store = new Map<string, unknown>();
  if (opts.auth !== undefined) store.set('auth', opts.auth);
  return {
    req: {
      param: (k: string) => (k === 'id' ? opts.param : undefined),
      json: async () => {
        if (opts.body === undefined) throw new Error('no body');
        return opts.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

function unpaidRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'o-1',
    userId: 'user-uuid',
    state: 'unpaid',
    ctxOrderId: 'ctx-1',
    ctxPaymentId: 'pay-1',
    ...overrides,
  };
}

function ctxResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  dbState.row = undefined;
  ctxFetchMock.mockReset();
  configState.nativeAuthEnabled = true;
});

describe('loopStellarTransactionHandler', () => {
  it('401s without a loop auth context', async () => {
    const res = await loopStellarTransactionHandler(
      makeCtx({ param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(401);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed source before touching the order', async () => {
    const res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: 'not-an-account' } }),
    );
    expect(res.status).toBe(400);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('404s on a missing or non-owner order', async () => {
    const res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(404);
  });

  it('409s once the order has left unpaid', async () => {
    dbState.row = unpaidRow({ state: 'paid' });
    const res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(409);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('relays the build call to CTX acting as the customer and returns the envelope', async () => {
    dbState.row = unpaidRow();
    ctxFetchMock.mockResolvedValue(
      ctxResponse(200, { xdr: 'AAAA', networkPassphrase: 'Test SDF Network ; September 2015' }),
    );
    const res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      xdr: 'AAAA',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ctx.test/payments/pay-1/stellar/transaction');
    expect(init.method).toBe('POST');
    const [, , options] = ctxFetchMock.mock.calls[0] as [string, RequestInit, CtxFetchOptions];
    expect(options.actAs).toEqual({ userId: 'user-uuid', clientId: undefined });
    expect(JSON.parse(init.body as string)).toEqual({ source: SOURCE });
  });

  it("surfaces CTX's 400 reason to the caller", async () => {
    dbState.row = unpaidRow();
    ctxFetchMock.mockResolvedValue(
      ctxResponse(400, {
        name: 'ErrBadRequest',
        message: 'stellar account GAAA does not exist on the network',
      }),
    );
    const res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'WALLET_PAYMENT_REJECTED',
      message: 'stellar account GAAA does not exist on the network',
    });
  });

  it('503s when CTX fails or drifts', async () => {
    dbState.row = unpaidRow();
    ctxFetchMock.mockResolvedValueOnce(ctxResponse(500, { name: 'ErrInternal' }));
    let res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(503);

    ctxFetchMock.mockResolvedValueOnce(ctxResponse(200, { unexpected: true }));
    res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(503);

    ctxFetchMock.mockRejectedValueOnce(new Error('timeout'));
    res = await loopStellarTransactionHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(503);
  });
});

describe('loopStellarSubmitHandler', () => {
  it('400s without a signed envelope', async () => {
    dbState.row = unpaidRow();
    const res = await loopStellarSubmitHandler(
      makeCtx({ auth: LOOP_AUTH, param: 'o-1', body: { source: SOURCE } }),
    );
    expect(res.status).toBe(400);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('relays the signed envelope and returns the transaction id', async () => {
    dbState.row = unpaidRow();
    ctxFetchMock.mockResolvedValue(ctxResponse(200, { txId: 'abc123' }));
    const res = await loopStellarSubmitHandler(
      makeCtx({
        auth: LOOP_AUTH,
        param: 'o-1',
        body: { source: SOURCE, signedXdr: 'AAAA-signed' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ txId: 'abc123' });

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ctx.test/payments/pay-1/stellar/submit');
    expect(JSON.parse(init.body as string)).toEqual({ source: SOURCE, signedXdr: 'AAAA-signed' });
  });
});
