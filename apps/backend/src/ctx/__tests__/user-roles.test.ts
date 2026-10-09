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

const setUserIsAdminMock = vi.hoisted(() => vi.fn());
const setUserHomeCurrencyMock = vi.hoisted(() => vi.fn());
const setUserCountryMock = vi.hoisted(() => vi.fn());
const getUserCtxUserIdMock = vi.hoisted(() => vi.fn());
vi.mock('../../db/users.js', () => ({
  setUserIsAdmin: setUserIsAdminMock,
  setUserHomeCurrency: setUserHomeCurrencyMock,
  setUserCountry: setUserCountryMock,
  getUserCtxUserId: getUserCtxUserIdMock,
}));

import {
  CtxUserRolesError,
  enqueueCtxAdminRoleSync,
  fetchCtxUserMirror,
  syncCtxAdminRole,
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
  setUserIsAdminMock.mockReset();
  setUserIsAdminMock.mockResolvedValue(true);
  setUserHomeCurrencyMock.mockReset();
  setUserHomeCurrencyMock.mockResolvedValue(true);
  setUserCountryMock.mockReset();
  setUserCountryMock.mockResolvedValue(true);
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

  it('maps the held stable to a Loop home currency, case-insensitively', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'XLM.EURC'));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ homeCurrency: 'EUR' });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'xlm.gbploop'));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ homeCurrency: 'GBP' });
  });

  it('reports no home currency when CTX carries none or an unknown stable', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([]));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ homeCurrency: null });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'XLM.XYZ'));
    await expect(fetchCtxUserMirror('ctx-u1')).resolves.toMatchObject({ homeCurrency: null });
  });

  it('throws on a non-ok status and on schema drift', async () => {
    ctxFetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(fetchCtxUserMirror('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
    ctxFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ roles: 'admin' })));
    await expect(fetchCtxUserMirror('ctx-u1')).rejects.toBeInstanceOf(CtxUserRolesError);
  });
});

describe('updateCtxStableCurrency', () => {
  it('PUTs the held stable for the home currency and returns the mirror', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([], 'XLM.GBPLOOP'));
    await expect(updateCtxStableCurrency('ctx-u1', 'GBP')).resolves.toMatchObject({
      homeCurrency: 'GBP',
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
    await expect(updateCtxStableCurrency('ctx-u1', 'GBP')).rejects.toMatchObject({ status: 400 });
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

describe('syncCtxAdminRole', () => {
  it('mirrors the CTX user country onto the Loop user', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([], undefined, 'PT'));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(setUserCountryMock).toHaveBeenCalledWith('loop-u1', 'PT');
  });

  it('leaves the country alone when CTX carries none', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([]));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(setUserCountryMock).not.toHaveBeenCalled();
  });

  it('mirrors the role onto the Loop user', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([{ name: 'operator-admin' }]));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(setUserIsAdminMock).toHaveBeenCalledWith('loop-u1', true);
  });

  it('clears the flag when CTX no longer lists the role', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([]));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(setUserIsAdminMock).toHaveBeenCalledWith('loop-u1', false);
  });

  it('mirrors the CTX stableCurrency onto the Loop home currency', async () => {
    ctxFetchMock.mockResolvedValue(ctxUser([], 'XLM.EURC'));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(setUserHomeCurrencyMock).toHaveBeenCalledWith('loop-u1', 'EUR');
  });

  it('leaves the home currency alone when CTX carries no mappable stable', async () => {
    ctxFetchMock.mockResolvedValueOnce(ctxUser([]));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    ctxFetchMock.mockResolvedValueOnce(ctxUser([], 'XLM.XYZ'));
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' });
    expect(setUserHomeCurrencyMock).not.toHaveBeenCalled();
  });

  it('skips unmapped users without touching CTX', async () => {
    await syncCtxAdminRole({ id: 'loop-u1', ctxUserId: null });
    expect(ctxFetchMock).not.toHaveBeenCalled();
    expect(setUserIsAdminMock).not.toHaveBeenCalled();
  });

  it('keeps the last mirrored values when CTX is unreachable', async () => {
    ctxFetchMock.mockRejectedValue(new Error('ctx down'));
    await expect(syncCtxAdminRole({ id: 'loop-u1', ctxUserId: 'ctx-u1' })).resolves.toBeUndefined();
    expect(setUserIsAdminMock).not.toHaveBeenCalled();
    expect(setUserHomeCurrencyMock).not.toHaveBeenCalled();
  });
});

describe('enqueueCtxAdminRoleSync', () => {
  it('resolves the mapping and syncs in the background', async () => {
    getUserCtxUserIdMock.mockResolvedValue('ctx-u1');
    ctxFetchMock.mockResolvedValue(ctxUser([{ name: 'operator-admin' }]));
    enqueueCtxAdminRoleSync('loop-u1');
    await flush();
    await flush();
    expect(setUserIsAdminMock).toHaveBeenCalledWith('loop-u1', true);
  });

  it('never throws into the caller', async () => {
    getUserCtxUserIdMock.mockRejectedValue(new Error('db down'));
    expect(() => enqueueCtxAdminRoleSync('loop-u1')).not.toThrow();
    await flush();
    expect(ctxFetchMock).not.toHaveBeenCalled();
  });
});
