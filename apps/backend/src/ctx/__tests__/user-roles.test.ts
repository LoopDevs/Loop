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

const applyCtxUserMirrorMock = vi.hoisted(() => vi.fn());
const getUserCtxUserIdMock = vi.hoisted(() => vi.fn());
vi.mock('../../db/users.js', () => ({
  applyCtxUserMirror: applyCtxUserMirrorMock,
  getUserCtxUserId: getUserCtxUserIdMock,
}));

import {
  CtxUserRolesError,
  enqueueCtxUserSync,
  fetchCtxUserMirror,
  syncCtxUser,
  updateCtxCountry,
  updateCtxStableCurrency,
} from '../user-roles.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function ctxUser(
  roles: Array<Record<string, unknown>>,
  stableCurrency?: string,
  country?: string,
): Response {
  return new Response(
    JSON.stringify({
      id: 'ctx-u1',
      email: 'u1@test.io',
      type: 'customer',
      roles,
      ...(stableCurrency === undefined ? {} : { stableCurrency }),
      ...(country === undefined ? {} : { country }),
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  ctxFetchMock.mockReset();
  applyCtxUserMirrorMock.mockReset();
  applyCtxUserMirrorMock.mockResolvedValue(null);
  getUserCtxUserIdMock.mockReset();
});

describe('fetchCtxUserMirror', () => {
  it('GETs the CTX user and reports the operator-admin role', async () => {
    ctxFetchMock.mockResolvedValue(
      ctxUser([{ name: 'operator-admin', assignedOn: '2026-09-01T00:00:00Z' }]),
    );
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ isAdmin: true });
    expect(String(ctxFetchMock.mock.calls[0]?.[0])).toBe('http://ctx.test/users/ctx-u1');
  });

  it('is non-admin for other roles and for a user with none', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([{ name: 'operator-viewer' }]));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ isAdmin: false });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([]));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ isAdmin: false });
  });

  it('reports the CTX stableCurrency uppercased', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'XLM.EURC'));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({
      stableCurrency: 'XLM.EURC',
    });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'xlm.gbploop'));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({
      stableCurrency: 'XLM.GBPLOOP',
    });
  });

  it('reports an empty stableCurrency when CTX carries none', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([]));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ stableCurrency: '' });
  });

  it('throws on a non-ok status and on schema drift', async () => {
    ctxFetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(fetchCtxUserMirror('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
    ctxFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ roles: 'admin' })));
    await expect(fetchCtxUserMirror('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
  });
});

describe('updateCtxStableCurrency', () => {
  it('PUTs the stable and returns the mirror', async () => {
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
  it('PUTs the country and returns it uppercased in the mirror', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([], undefined, 'gb'));
    await expect(updateCtxCountry('ctx-u1', 'GB')).resolves.toMatchObject({ country: 'GB' });
    const [url, init] = ctxFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://ctx.test/users/ctx-u1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ country: 'GB' });
  });

  it('reports no country when CTX carries none', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([]));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ country: null });
  });
});

describe('syncCtxUser', () => {
  it('writes the whole CTX mirror onto the Loop user', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([{ name: 'operator-admin' }], 'XLM.EURC', 'PT'));
    await syncCtxUser({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(applyCtxUserMirrorMock).toHaveBeenCalledWith('loop-u1', {
      isAdmin: true,
      stableCurrency: 'XLM.EURC',
      cashbackDestination: 'account',
      country: 'PT',
    });
  });

  it('writes an empty stable, no country and a cleared role when CTX carries none', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([]));
    await syncCtxUser({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(applyCtxUserMirrorMock).toHaveBeenCalledWith('loop-u1', {
      isAdmin: false,
      stableCurrency: '',
      cashbackDestination: 'account',
      country: null,
    });
  });

  it('skips unmapped users without touching CTX', async () => {
    await syncCtxUser({ id: 'loop-u1', ctxUserId: null });
    expect(ctxFetchMock).not.toHaveBeenCalled();
    expect(applyCtxUserMirrorMock).not.toHaveBeenCalled();
  });

  it('keeps the last mirrored values when CTX is unreachable', async () => {
    ctxFetchMock.mockRejectedValue(new Error('ctx down'));
    await expect(syncCtxUser({ id: 'loop-u1', ctxUserId: 'ctx-u1' })).resolves.toBeUndefined();
    expect(applyCtxUserMirrorMock).not.toHaveBeenCalled();
  });
});

describe('enqueueCtxUserSync', () => {
  it('resolves the mapping and syncs in the background', async () => {
    getUserCtxUserIdMock.mockResolvedValue('ctx-u1');
    ctxFetchMock.mockResolvedValue(ctxUser([{ name: 'operator-admin' }]));
    enqueueCtxUserSync('loop-u1');
    await flush();
    await flush();
    expect(applyCtxUserMirrorMock).toHaveBeenCalledWith(
      'loop-u1',
      expect.objectContaining({ isAdmin: true }),
    );
  });

  it('never throws into the caller', async () => {
    getUserCtxUserIdMock.mockRejectedValue(new Error('db down'));
    expect(() => enqueueCtxUserSync('loop-u1')).not.toThrow();
    await flush();
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });
});
