import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { ctxState } = vi.hoisted(() => ({
  ctxState: {
    credentials: { key: 'op-key', secret: 'op-secret' } as { key: string; secret: string },
  },
}));
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

const { startCtxWsMock, stopCtxWsMock } = vi.hoisted(() => ({
  startCtxWsMock: vi.fn(),
  stopCtxWsMock: vi.fn(),
}));
vi.mock('../ws-events.js', () => ({
  startCtxWs: startCtxWsMock,
  stopCtxWs: stopCtxWsMock,
}));

import { startCtx, stopCtx, getLoopContext, __resetCtxStartupForTests } from '../startup.js';

const company = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'company-1',
  name: 'Loop',
  type: 'operator',
  disableUserEmails: true,
  ...overrides,
});

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
    ctxState.credentials = { key: 'op-key', secret: 'op-secret' };
  });

  it('throws before any CTX call when the api key is unset', async () => {
    ctxState.credentials = { key: '', secret: 'op-secret' };

    await expect(startCtx()).rejects.toThrow(/credentials/);
    expect(ctxFetchMock).not.toHaveBeenCalled();
    expect(startCtxWsMock).not.toHaveBeenCalled();
  });

  it('throws before any CTX call when the api secret is unset', async () => {
    ctxState.credentials = { key: 'op-key', secret: '  ' };

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
