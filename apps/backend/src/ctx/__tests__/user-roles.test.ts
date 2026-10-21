import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

const ctxFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../api-fetch.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ctxFetch: ctxFetchMock,
}));

import {
  CtxUserRolesError,
  enableCtxUser,
  fetchCtxUser,
  updateCtxCountry,
  updateCtxStableCurrency,
} from '../user-roles.js';

function ctxUser(
  roles: Array<Record<string, unknown>>,
  stableCurrency?: string,
  country?: string,
): Response {
  return new Response(
    JSON.stringify({
      id: 'ctx-u1',
      email: 'U1@Test.io',
      type: 'customer',
      status: 'enabled',
      roles,
      ...(stableCurrency === undefined ? {} : { stableCurrency }),
      ...(country === undefined ? {} : { country }),
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  ctxFetchMock.mockReset();
});

describe('fetchCtxUser', () => {
  it('returns the whole CTX user with a lowercased email', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([{ name: 'operator-admin' }], 'XLM.EURC', 'pt'));
    await expect(fetchCtxUser('ctx-u1')).resolves.toEqual({
      id: 'ctx-u1',
      email: 'u1@test.io',
      status: 'enabled',
      isAdmin: true,
      stableCurrency: 'XLM.EURC',
      cashbackDestination: 'account',
      country: 'PT',
    });
  });

  it('reports the CTX status', async () => {
    ctxFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'ctx-u1', status: 'suspended', roles: [] })),
    );
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({ status: 'suspended', email: '' });
  });

  it('throws on schema drift when CTX omits the status', async () => {
    ctxFetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'ctx-u1', roles: [] })));
    await expect(fetchCtxUser('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
  });

  it('GETs the CTX user and reports the operator-admin role', async () => {
    ctxFetchMock.mockResolvedValue(
      ctxUser([{ name: 'operator-admin', assignedOn: '2026-09-01T00:00:00Z' }]),
    );
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({ isAdmin: true });
    expect(String(ctxFetchMock.mock.calls[0]?.[0])).toBe('http://ctx.test/users/ctx-u1');
  });

  it('is non-admin for other roles and for a user with none', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([{ name: 'operator-viewer' }]));
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({ isAdmin: false });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([]));
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({ isAdmin: false });
  });

  it('reports the CTX stableCurrency uppercased', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'XLM.EURC'));
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({
      stableCurrency: 'XLM.EURC',
    });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'xlm.gbploop'));
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({
      stableCurrency: 'XLM.GBPLOOP',
    });
  });

  it('reports an empty stableCurrency when CTX carries none', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([]));
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({ stableCurrency: '' });
  });

  it('throws on a non-ok status and on schema drift', async () => {
    ctxFetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(fetchCtxUser('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
    ctxFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ roles: 'admin' })));
    await expect(fetchCtxUser('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
  });
});

describe('enableCtxUser', () => {
  it('POSTs the enabled status and returns the CTX user', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([{ name: 'operator-admin' }]));
    await expect(enableCtxUser('ctx-u1')).resolves.toMatchObject({
      id: 'ctx-u1',
      status: 'enabled',
      isAdmin: true,
    });
    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://ctx.test/users/ctx-u1/status');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'enabled' });
  });

  it('throws with the CTX status on rejection', async () => {
    ctxFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not authorized' }), { status: 403 }),
    );
    await expect(enableCtxUser('ctx-u1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('updateCtxStableCurrency', () => {
  it('PUTs the stable and returns the CTX user', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([], 'XLM.GBPLOOP'));
    await expect(updateCtxStableCurrency('ctx-u1', 'XLM.GBPLOOP')).resolves.toMatchObject({
      stableCurrency: 'XLM.GBPLOOP',
    });
    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://ctx.test/users/ctx-u1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ stableCurrency: 'XLM.GBPLOOP' });
  });

  it('throws with the CTX status on rejection', async () => {
    ctxFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }),
    );
    await expect(updateCtxStableCurrency('ctx-u1', 'XLM.GBPLOOP')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('updateCtxCountry', () => {
  it('PUTs the country and returns it uppercased on the CTX user', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([], undefined, 'gb'));
    await expect(updateCtxCountry('ctx-u1', 'GB')).resolves.toMatchObject({ country: 'GB' });
    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://ctx.test/users/ctx-u1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ country: 'GB' });
  });

  it('reports no country when CTX carries none', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([]));
    await expect(fetchCtxUser('ctx-u1')).resolves.toMatchObject({ country: null });
  });
});
