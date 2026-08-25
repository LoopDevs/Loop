import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('logs and stores nothing on a 400 (uniqueness rejection)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ operatorUserId: 'already exists' }), { status: 400 }),
    );

    await provisionCtxUser(user);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
  });

  it('stores nothing on response schema drift', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), { status: 201 }),
    );

    await provisionCtxUser(user);
    expect(setUserCtxUserIdMock).not.toHaveBeenCalled();
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

  it('is a no-op when operator credentials are absent', async () => {
    mockEnv['GIFT_CARD_API_KEY'] = undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    enqueueCtxUserProvisioning({ ...user, id: 'no-creds' });
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

  it('returns null when operator credentials are absent', () => {
    mockEnv['GIFT_CARD_API_SECRET'] = undefined;
    expect(ctxActAsHeaders('ctx-u9')).toBeNull();
  });
});
