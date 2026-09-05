import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const mockEnv = vi.hoisted(
  () =>
    ({
      CTX_USER_PROVISIONING_ENABLED: true,
      GIFT_CARD_API_KEY: 'op-key',
      GIFT_CARD_API_SECRET: 'op-secret',
      CTX_CLIENT_ID_WEB: 'loopweb',
    }) as Record<string, unknown>,
);
vi.mock('../../env.js', () => ({ env: mockEnv }));

vi.mock('../../upstream.js', () => ({
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

const setUserCtxUserIdMock = vi.hoisted(() => vi.fn());
vi.mock('../../db/users.js', () => ({
  setUserCtxUserId: setUserCtxUserIdMock,
}));

import {
  enqueueCtxUserProvisioning,
  provisionCtxUser,
  adoptExistingCtxUser,
  ctxActAsHeaders,
} from '../user-provisioning.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const user = { id: 'loop-u1', email: 'u1@test.io', ctxUserId: null };

describe('provisionCtxUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setUserCtxUserIdMock.mockReset();
    setUserCtxUserIdMock.mockResolvedValue(true);
    mockEnv['CTX_USER_PROVISIONING_ENABLED'] = true;
    mockEnv['GIFT_CARD_API_KEY'] = 'op-key';
    mockEnv['GIFT_CARD_API_SECRET'] = 'op-secret';
  });

  it('POSTs /users with operator API creds + operatorUserId and stores the returned id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'ctx-u1' }), { status: 201 }));

    await provisionCtxUser(user);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ctx.test/users');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('op-key');
    expect(headers['X-Api-Secret']).toBe('op-secret');
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toEqual({ email: 'u1@test.io', type: 'customer', operatorUserId: 'loop-u1' });
    expect(setUserCtxUserIdMock).toHaveBeenCalledWith('loop-u1', 'ctx-u1');
  });

  it('logs and stores nothing on a non-email 400 (operatorUserId uniqueness rejection)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'bad request', fields: { operatorUserId: ['already exists'] } }),
          { status: 400 },
        ),
      );

    await provisionCtxUser(user);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
    // No adoption lookup either — only the email-exists 400 triggers it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stores nothing on response schema drift', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), { status: 201 }),
    );

    await provisionCtxUser(user);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
  });
});

/**
 * Route a mocked upstream by method + path. Each entry returns a FRESH
 * Response per call — Response bodies are single-use.
 */
function routeFetch(
  routes: Array<{ method: string; match: (url: string) => boolean; respond: () => Response }>,
): MockInstance<typeof globalThis.fetch> {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const route = routes.find((r) => r.method === method && r.match(url));
      if (!route) throw new Error(`unrouted mock fetch: ${method} ${url}`);
      return route.respond();
    });
}

const emailExists400 = (): Response =>
  new Response(JSON.stringify({ error: 'bad request', fields: { email: ['already exists'] } }), {
    status: 400,
  });

describe('adoption on email-exists 400', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setUserCtxUserIdMock.mockReset();
    setUserCtxUserIdMock.mockResolvedValue(true);
    mockEnv['CTX_USER_PROVISIONING_ENABLED'] = true;
    mockEnv['GIFT_CARD_API_KEY'] = 'op-key';
    mockEnv['GIFT_CARD_API_SECRET'] = 'op-secret';
  });

  it('claims the unclaimed pre-contract customer and stores its id', async () => {
    const fetchSpy = routeFetch([
      { method: 'POST', match: (u) => u === 'http://ctx.test/users', respond: emailExists400 },
      {
        method: 'GET',
        match: (u) => u.startsWith('http://ctx.test/users?'),
        respond: () =>
          new Response(
            JSON.stringify({
              result: [{ id: 'ctx-legacy', email: 'u1@test.io', type: 'customer' }],
            }),
            { status: 200 },
          ),
      },
      {
        method: 'PUT',
        match: (u) => u === 'http://ctx.test/users/ctx-legacy',
        respond: () => new Response(JSON.stringify({ id: 'ctx-legacy' }), { status: 200 }),
      },
    ]);

    await provisionCtxUser(user);

    // Lookup is regex-escaped + type-narrowed.
    const getCall = fetchSpy.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'GET');
    expect(String(getCall?.[0])).toBe(
      `http://ctx.test/users?type=customer&email=${encodeURIComponent('u1@test\\.io')}`,
    );
    // The claim carries our Loop user id.
    const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse((putCall?.[1] as RequestInit).body as string)).toEqual({
      operatorUserId: 'loop-u1',
    });
    expect(setUserCtxUserIdMock).toHaveBeenCalledWith('loop-u1', 'ctx-legacy');
  });

  it('skips the claim when CTX already carries our operatorUserId, and just stores', async () => {
    const fetchSpy = routeFetch([
      { method: 'POST', match: (u) => u === 'http://ctx.test/users', respond: emailExists400 },
      {
        method: 'GET',
        match: (u) => u.startsWith('http://ctx.test/users?'),
        respond: () =>
          new Response(
            JSON.stringify({
              result: [
                {
                  id: 'ctx-legacy',
                  email: 'u1@test.io',
                  type: 'customer',
                  operatorUserId: 'loop-u1',
                },
              ],
            }),
            { status: 200 },
          ),
      },
    ]);

    await provisionCtxUser(user);

    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(setUserCtxUserIdMock).toHaveBeenCalledWith('loop-u1', 'ctx-legacy');
  });

  it('never adopts a customer mapped to a DIFFERENT Loop user', async () => {
    const fetchSpy = routeFetch([
      { method: 'POST', match: (u) => u === 'http://ctx.test/users', respond: emailExists400 },
      {
        method: 'GET',
        match: (u) => u.startsWith('http://ctx.test/users?'),
        respond: () =>
          new Response(
            JSON.stringify({
              result: [
                {
                  id: 'ctx-legacy',
                  email: 'u1@test.io',
                  type: 'customer',
                  operatorUserId: 'someone-else',
                },
              ],
            }),
            { status: 200 },
          ),
      },
    ]);

    await provisionCtxUser(user);

    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
  });

  it('stores nothing when the regex lookup returns only superstring emails', async () => {
    routeFetch([
      { method: 'POST', match: (u) => u === 'http://ctx.test/users', respond: emailExists400 },
      {
        method: 'GET',
        match: (u) => u.startsWith('http://ctx.test/users?'),
        respond: () =>
          new Response(
            JSON.stringify({
              result: [{ id: 'ctx-other', email: 'xu1@test.iox', type: 'customer' }],
            }),
            { status: 200 },
          ),
      },
    ]);

    await provisionCtxUser(user);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
  });

  it('stores nothing when the operatorUserId claim is rejected', async () => {
    routeFetch([
      { method: 'POST', match: (u) => u === 'http://ctx.test/users', respond: emailExists400 },
      {
        method: 'GET',
        match: (u) => u.startsWith('http://ctx.test/users?'),
        respond: () =>
          new Response(
            JSON.stringify({
              result: [{ id: 'ctx-legacy', email: 'u1@test.io', type: 'customer' }],
            }),
            { status: 200 },
          ),
      },
      {
        method: 'PUT',
        match: (u) => u === 'http://ctx.test/users/ctx-legacy',
        respond: () =>
          new Response(
            JSON.stringify({
              error: 'bad request',
              fields: { operatorUserId: ['already exists'] },
            }),
            { status: 400 },
          ),
      },
    ]);

    await provisionCtxUser(user);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
  });

  it('is exported for direct backfill use', async () => {
    routeFetch([
      {
        method: 'GET',
        match: (u) => u.startsWith('http://ctx.test/users?'),
        respond: () =>
          new Response(
            JSON.stringify({
              result: [{ id: 'ctx-legacy', email: 'u1@test.io', type: 'customer' }],
            }),
            { status: 200 },
          ),
      },
      {
        method: 'PUT',
        match: (u) => u === 'http://ctx.test/users/ctx-legacy',
        respond: () => new Response(JSON.stringify({ id: 'ctx-legacy' }), { status: 200 }),
      },
    ]);

    await adoptExistingCtxUser(user);
    expect(setUserCtxUserIdMock).toHaveBeenCalledWith('loop-u1', 'ctx-legacy');
  });
});

describe('enqueueCtxUserProvisioning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setUserCtxUserIdMock.mockReset();
    setUserCtxUserIdMock.mockResolvedValue(true);
    mockEnv['CTX_USER_PROVISIONING_ENABLED'] = true;
    mockEnv['GIFT_CARD_API_KEY'] = 'op-key';
    mockEnv['GIFT_CARD_API_SECRET'] = 'op-secret';
  });

  it('is a no-op when the feature flag is off', async () => {
    mockEnv['CTX_USER_PROVISIONING_ENABLED'] = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    enqueueCtxUserProvisioning({ ...user, id: 'flag-off' });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when the user is already mapped', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    enqueueCtxUserProvisioning({ ...user, id: 'mapped', ctxUserId: 'ctx-existing' });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws into the caller when the upstream call rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ctx down'));

    expect(() => enqueueCtxUserProvisioning({ ...user, id: 'ctx-down' })).not.toThrow();
    await flush();
  });
});

describe('ctxActAsHeaders', () => {
  beforeEach(() => {
    mockEnv['GIFT_CARD_API_KEY'] = 'op-key';
    mockEnv['GIFT_CARD_API_SECRET'] = 'op-secret';
  });

  it('returns the full act-as header set for a mapped user', () => {
    expect(ctxActAsHeaders('ctx-u9')).toEqual({
      'X-Api-Key': 'op-key',
      'X-Api-Secret': 'op-secret',
      'X-User-Id': 'ctx-u9',
      'X-Client-Id': 'loopweb',
    });
  });

  it('returns null for an unmapped user', () => {
    expect(ctxActAsHeaders(null)).toBeNull();
  });
});
