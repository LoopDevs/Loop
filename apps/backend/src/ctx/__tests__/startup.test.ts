import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { ctxState, PRIVATE_KEY } = vi.hoisted(() => {
  const PRIVATE_KEY = '11'.repeat(32);
  return {
    PRIVATE_KEY,
    ctxState: {
      credentials: { key: 'op-key', secret: 'op-secret', privateKey: PRIVATE_KEY } as {
        key: string;
        secret?: string;
        privateKey: string;
      },
    },
  };
});
vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        ctx: {
          ...actual.config.ctx,
          credentials: ctxState.credentials,
        },
      };
    },
  };
});

vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

const ctxFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../api-fetch.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ctxFetch: ctxFetchMock,
}));

const { startCtxWsMock, stopCtxWsMock, registerCtxWsTopicMock } = vi.hoisted(() => ({
  startCtxWsMock: vi.fn(),
  stopCtxWsMock: vi.fn(),
  registerCtxWsTopicMock: vi.fn(),
}));

const { loadCtxCurrenciesMock, refreshCtxCurrenciesMock } = vi.hoisted(() => ({
  loadCtxCurrenciesMock: vi.fn(async () => undefined),
  refreshCtxCurrenciesMock: vi.fn(async () => undefined),
}));
vi.mock('../currencies.js', () => ({
  loadCtxCurrencies: loadCtxCurrenciesMock,
  refreshCtxCurrencies: refreshCtxCurrenciesMock,
  isCtxFiatCurrency: (code: string) => ['GBP', 'USD', 'EUR'].includes(code),
  isCtxCryptoCurrency: (code: string) => ['XLM', 'DASH', 'ETH'].includes(code),
}));
vi.mock('../ws-events.js', () => ({
  startCtxWs: startCtxWsMock,
  stopCtxWs: stopCtxWsMock,
  registerCtxWsTopic: registerCtxWsTopicMock,
}));

import {
  startCtx,
  stopCtx,
  getLoopContext,
  loopCountries,
  loopCryptoPaymentCurrencies,
  loopFiatPaymentCurrencies,
  loopPaymentCurrencies,
  loopStableCurrencies,
  peekLoopCompany,
  refreshLoopContext,
  __resetCtxStartupForTests,
} from '../startup.js';
import type { CtxWsTopicHandler } from '../ws-events.js';

const company = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'company-1',
  name: 'Loop',
  type: 'operator',
  disableUserEmails: true,
  countries: ['US', 'GB'],
  paymentCurrencies: ['XLM', 'dash', 'GBP'],
  stableCurrencies: ['XLM.USDC'],
  profitShareBasisPoints: 5000,
  ...overrides,
});

const registeredCompanyTopic = (): CtxWsTopicHandler => {
  const handler = registerCtxWsTopicMock.mock.calls
    .map((call) => call[0] as CtxWsTopicHandler)
    .find((h) => h.topic === 'company');
  if (handler === undefined) throw new Error('company topic not registered');
  return handler;
};

const meResponse = (companyOverrides: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ user: { id: 'u1' }, company: company(companyOverrides) }), {
    status: 200,
  });

describe('startCtx', () => {
  beforeEach(() => {
    __resetCtxStartupForTests();
    ctxFetchMock.mockReset();
    startCtxWsMock.mockReset();
    stopCtxWsMock.mockReset();
    registerCtxWsTopicMock.mockReset();
    loadCtxCurrenciesMock.mockReset();
    loadCtxCurrenciesMock.mockResolvedValue(undefined);
    refreshCtxCurrenciesMock.mockReset();
    refreshCtxCurrenciesMock.mockResolvedValue(undefined);
    ctxState.credentials = { key: 'op-key', secret: 'op-secret', privateKey: PRIVATE_KEY };
  });

  it('proves the api key with GET /me before loading the CTX currency registry', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse());

    await startCtx();

    expect(loadCtxCurrenciesMock).toHaveBeenCalledTimes(1);
    expect(ctxFetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadCtxCurrenciesMock.mock.invocationCallOrder[0]!,
    );
  });

  it('refuses to start when the CTX currency registry cannot be loaded', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse());
    loadCtxCurrenciesMock.mockRejectedValueOnce(
      new Error('CTX startup failed: GET /currencies failed'),
    );

    await expect(startCtx()).rejects.toThrow(/currencies/);
    expect(ctxFetchMock).toHaveBeenCalledTimes(1);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('exposes the operator countries and currencies from the company', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse());

    await startCtx();

    expect(loopCountries()).toEqual(['US', 'GB']);
    expect(loopPaymentCurrencies()).toEqual(['XLM', 'DASH', 'GBP']);
    expect(loopCryptoPaymentCurrencies()).toEqual(['XLM', 'DASH']);
    expect(loopFiatPaymentCurrencies()).toEqual(['GBP']);
    expect(loopStableCurrencies()).toEqual(['XLM.USDC']);
    expect(peekLoopCompany()?.profitShareBasisPoints).toBe(5000);
  });

  it('defaults countries and currencies to empty lists when CTX omits them', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      meResponse({
        countries: undefined,
        paymentCurrencies: undefined,
        stableCurrencies: undefined,
      }),
    );

    await startCtx();

    expect(loopCountries()).toEqual([]);
    expect(loopPaymentCurrencies()).toEqual([]);
    expect(loopStableCurrencies()).toEqual([]);
  });

  it('ignores payment currencies the CTX registry does not know', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse({ paymentCurrencies: ['XLM', 'ZZZ', 'GBP'] }));

    await startCtx();

    expect(loopCryptoPaymentCurrencies()).toEqual(['XLM']);
    expect(loopFiatPaymentCurrencies()).toEqual(['GBP']);
  });

  it('subscribes to the company ws topic and applies company updates for its own company', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse());
    await startCtx();

    const handler = registeredCompanyTopic();
    expect([...handler.events]).toEqual(
      expect.arrayContaining(['system.company.updated', 'system.company.status_changed']),
    );

    await handler.onEvent(
      'system.company.updated',
      company({ id: 'someone-else', countries: ['FR'] }),
    );
    expect(loopCountries()).toEqual(['US', 'GB']);

    await handler.onEvent('system.company.updated', company({ countries: ['US', 'GB', 'DE'] }));
    expect(loopCountries()).toEqual(['US', 'GB', 'DE']);

    await handler.onEvent('system.company.updated', { nope: true });
    expect(loopCountries()).toEqual(['US', 'GB', 'DE']);
  });

  it('re-reads GET /me after a ws resubscribe and on refresh', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(meResponse({ paymentCurrencies: ['XLM', 'DASH', 'ETH'] }))
      .mockResolvedValueOnce(new Response('down', { status: 503 }));
    await startCtx();

    registeredCompanyTopic().onSubscribed?.({ resubscribe: true });
    await vi.waitFor(() => expect(loopPaymentCurrencies()).toEqual(['XLM', 'DASH', 'ETH']));

    await refreshLoopContext();
    expect(loopPaymentCurrencies()).toEqual(['XLM', 'DASH', 'ETH']);
    expect(ctxFetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws before any CTX call when the api key is unset', async () => {
    ctxState.credentials = { key: '', secret: 'op-secret', privateKey: PRIVATE_KEY };

    await expect(startCtx()).rejects.toThrow(/credentials/);
    expect(ctxFetchMock).not.toHaveBeenCalled();
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('throws before any CTX call when the private key is unset', async () => {
    ctxState.credentials = { key: 'op-key', secret: 'op-secret', privateKey: '  ' };

    await expect(startCtx()).rejects.toThrow(/credentials/);
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });

  it('fetches GET /me, stores the loop context, and connects the websocket', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse());

    await startCtx();

    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/me');
    expect(init.method).toBe('GET');
    expect(ctxFetchMock).toHaveBeenCalledTimes(1);
    expect(startCtxWsMock).toHaveBeenCalledTimes(1);
    expect(getLoopContext().company).toMatchObject({ id: 'company-1', disableUserEmails: true });
  });

  it('throws and leaves the websocket unconnected when GET /me returns a non-2xx status', async () => {
    ctxFetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    await expect(startCtx()).rejects.toThrow(/GET \/me returned 500/);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('throws when GET /me fails at the transport level', async () => {
    ctxFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(startCtx()).rejects.toThrow(/GET \/me failed/);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('throws when GET /me responds without a company', async () => {
    ctxFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }),
    );

    await expect(startCtx()).rejects.toThrow(/shape invalid/);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('updates the company via PUT /companies/:id when disableUserEmails is false', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(meResponse({ disableUserEmails: false }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(company({ disableUserEmails: true })), { status: 200 }),
      );

    await startCtx();

    const [url, init] = ctxFetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/companies/company-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ disableUserEmails: true });
    expect(startCtxWsMock).toHaveBeenCalledTimes(1);
    expect(getLoopContext().company.disableUserEmails).toBe(true);
  });

  it('throws when the company update returns a non-2xx status', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(meResponse({ disableUserEmails: false }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    await expect(startCtx()).rejects.toThrow(/PUT \/companies\/company-1 returned 403/);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('throws when disableUserEmails is still false after the update', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(meResponse({ disableUserEmails: false }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(company({ disableUserEmails: false })), { status: 200 }),
      );

    await expect(startCtx()).rejects.toThrow(/still false after update/);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });
});

describe('startCtx signing key registration', () => {
  const PUBLIC_KEY = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';

  type FetchCall = [string, RequestInit, { proof?: string; passthrough401?: boolean } | undefined];
  const calls = (): FetchCall[] => ctxFetchMock.mock.calls as FetchCall[];
  const rejected = (): Response => new Response('{"error":"not authorized"}', { status: 401 });

  beforeEach(() => {
    __resetCtxStartupForTests();
    ctxFetchMock.mockReset();
    startCtxWsMock.mockReset();
    registerCtxWsTopicMock.mockReset();
    loadCtxCurrenciesMock.mockReset();
    loadCtxCurrenciesMock.mockResolvedValue(undefined);
    ctxState.credentials = { key: 'op-key', secret: 'op-secret', privateKey: PRIVATE_KEY };
  });

  it('probes GET /me signed and lets a 401 through instead of throwing', async () => {
    ctxFetchMock.mockResolvedValueOnce(meResponse());

    await startCtx();

    expect(calls()).toHaveLength(1);
    expect(calls()[0]![2]).toEqual({ passthrough401: true });
  });

  it('registers the public key with the secret after a signed 401, then probes signed again', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(new Response('{"id":"key-1"}', { status: 201 }))
      .mockResolvedValueOnce(meResponse());

    await startCtx();

    expect(calls()).toHaveLength(4);
    expect(calls()[0]![0]).toBe('http://ctx.test/me');
    expect(calls()[0]![2]).toEqual({ passthrough401: true });
    expect(calls()[1]![0]).toBe('http://ctx.test/me');
    expect(calls()[1]![2]).toEqual({ proof: 'secret', passthrough401: true });
    expect(calls()[2]![0]).toBe('http://ctx.test/users/u1/signing-keys');
    expect(calls()[2]![1].method).toBe('POST');
    expect(JSON.parse(calls()[2]![1].body as string)).toEqual({
      publicKey: PUBLIC_KEY,
      scheme: 'secp256k1',
    });
    expect(calls()[2]![2]).toEqual({ proof: 'secret' });
    expect(calls()[3]![0]).toBe('http://ctx.test/me');
    expect(calls()[3]![2]).toBeUndefined();
    expect(startCtxWsMock).toHaveBeenCalledTimes(1);
    expect(getLoopContext().company.id).toBe('company-1');
  });

  it('fails when the signed probe is rejected and no secret is configured to register the key', async () => {
    ctxState.credentials = { key: 'op-key', privateKey: PRIVATE_KEY };
    ctxFetchMock.mockResolvedValueOnce(rejected());

    await expect(startCtx()).rejects.toThrow(/ctx\.credentials\.secret is not set/);
    expect(calls()).toHaveLength(1);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('fails when CTX rejects the legacy secret too', async () => {
    ctxFetchMock.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected());

    await expect(startCtx()).rejects.toThrow(/legacy secret returned 401/);
    expect(calls()).toHaveLength(2);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('fails when CTX refuses the public key registration', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(new Response('{"fields":{"publicKey":["exists"]}}', { status: 400 }));

    await expect(startCtx()).rejects.toThrow(/signing-keys returned 400/);
    expect(calls()).toHaveLength(3);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('fails when the signed probe is still rejected after registration', async () => {
    ctxFetchMock
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(new Response('{"id":"key-1"}', { status: 201 }))
      .mockRejectedValueOnce(new Error('CTX rejected the API key (401)'));

    await expect(startCtx()).rejects.toThrow(/GET \/me failed/);
    expect(calls()).toHaveLength(4);
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });
});

describe('getLoopContext', () => {
  beforeEach(() => {
    __resetCtxStartupForTests();
  });

  it('throws while startCtx has not completed', () => {
    expect(() => getLoopContext()).toThrow(/startCtx/);
  });
});

describe('stopCtx', () => {
  it('closes the websocket', () => {
    stopCtx();
    expect(stopCtxWsMock).toHaveBeenCalledTimes(1);
  });
});
