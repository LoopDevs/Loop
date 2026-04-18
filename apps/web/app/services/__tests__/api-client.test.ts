import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing api-client
vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

// Mocks that authenticatedRequest / tryRefresh dynamically import. The
// auth store also reaches into this module, so we expose stubs for every
// exported function — unused ones are no-ops.
const mockGetRefreshToken = vi.fn<() => Promise<string | null>>();
const mockStoreRefreshToken = vi.fn<(token: string) => Promise<void>>();
const mockClearRefreshToken = vi.fn<() => Promise<void>>();
vi.mock('~/native/secure-storage', () => ({
  getRefreshToken: () => mockGetRefreshToken(),
  storeRefreshToken: (t: string) => mockStoreRefreshToken(t),
  clearRefreshToken: () => mockClearRefreshToken(),
  storeEmail: vi.fn(async () => undefined),
  getEmail: vi.fn(async () => null),
}));

const mockGetPlatform = vi.fn<() => 'web' | 'ios' | 'android'>();
vi.mock('~/native/platform', () => ({
  getPlatform: () => mockGetPlatform(),
}));

import { apiRequest, authenticatedRequest, tryRefresh } from '../api-client';
import { ApiException } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';

describe('apiRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a GET request and returns JSON', async () => {
    const mockData = { merchants: [] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockData), { status: 200 }),
    );

    const result = await apiRequest('/api/merchants');
    expect(result).toEqual(mockData);
    expect(fetch).toHaveBeenCalledWith(
      'http://test-api/api/merchants',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends JSON body for POST requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiRequest('/api/auth/request-otp', {
      method: 'POST',
      body: { email: 'test@example.com' },
    });

    const call = vi.mocked(fetch).mock.calls[0]!;
    const [, init] = call;
    expect(init?.body).toBe(JSON.stringify({ email: 'test@example.com' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws ApiException on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), { status: 404 }),
    );

    await expect(apiRequest('/api/missing')).rejects.toThrow(ApiException);
  });

  it('includes error code from JSON error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), { status: 404 }),
    );

    await expect(apiRequest('/api/missing')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('falls back to UPSTREAM_ERROR when error response is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(apiRequest('/api/broken')).rejects.toMatchObject({
      status: 500,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('returns ArrayBuffer when binary option is set', async () => {
    const buffer = new ArrayBuffer(8);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buffer, { status: 200 }));

    const result = await apiRequest('/api/image', { binary: true });
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it('passes an AbortSignal with the request (timeout wired up)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await apiRequest('/api/merchants');

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('translates TimeoutError into ApiException{ code: TIMEOUT }', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );

    await expect(apiRequest('/api/slow')).rejects.toMatchObject({
      name: 'ApiException',
      code: 'TIMEOUT',
      status: 0,
    });
  });

  it('translates other fetch rejections into ApiException{ code: NETWORK_ERROR }', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));

    await expect(apiRequest('/api/broken')).rejects.toMatchObject({
      name: 'ApiException',
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });

  it('honors timeoutMs=0 to disable the default timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await apiRequest('/api/slow-on-purpose', { timeoutMs: 0 });

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    // No caller signal + timeoutMs=0 means we don't pass a signal at all.
    expect(init.signal ?? null).toBeNull();
  });

  it('defaults to UPSTREAM_ERROR code when error body has no code field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );
    await expect(apiRequest('/api/broken')).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_ERROR',
      message: 'Bad Gateway',
    });
  });

  it('defaults to UPSTREAM_ERROR when error body is a JSON array (wrong shape)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(['unexpected']), { status: 500, statusText: 'err' }),
    );
    await expect(apiRequest('/api/broken')).rejects.toMatchObject({
      status: 500,
      code: 'UPSTREAM_ERROR',
    });
  });
});

describe('tryRefresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetRefreshToken.mockReset();
    mockStoreRefreshToken.mockReset();
    mockClearRefreshToken.mockResolvedValue();
    mockGetPlatform.mockReturnValue('web');
    // `clearSession()` itself calls `clearRefreshToken()` via the mock, so
    // reset the spy AFTER clearing auth state — otherwise every test
    // starts at callCount === 1 and the "not called" assertions below
    // fail spuriously.
    useAuthStore.getState().clearSession();
    mockClearRefreshToken.mockClear();
  });

  it('returns null when no refresh token is stored', async () => {
    mockGetRefreshToken.mockResolvedValue(null);
    const result = await tryRefresh();
    expect(result).toBeNull();
  });

  it('returns the new access token when the upstream accepts refresh', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'at-new' }), { status: 200 }),
    );
    const token = await tryRefresh();
    expect(token).toBe('at-new');
  });

  it('persists a rotated refresh token before resolving', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    mockStoreRefreshToken.mockResolvedValue();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'at-new', refreshToken: 'rt-rotated' }), {
        status: 200,
      }),
    );
    const token = await tryRefresh();
    expect(token).toBe('at-new');
    expect(mockStoreRefreshToken).toHaveBeenCalledWith('rt-rotated');
  });

  it('returns null when upstream rejects the refresh token', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-bad');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), { status: 401 }),
    );
    const token = await tryRefresh();
    expect(token).toBeNull();
  });

  it('coalesces concurrent callers into a single upstream request', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ accessToken: 'at-coalesced' }), { status: 200 }),
      );

    const [a, b, c] = await Promise.all([tryRefresh(), tryRefresh(), tryRefresh()]);
    expect(a).toBe('at-coalesced');
    expect(b).toBe('at-coalesced');
    expect(c).toBe('at-coalesced');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the stored refresh token on definitive rejection (audit A-020)', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-expired');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), { status: 401 }),
    );
    const token = await tryRefresh();
    expect(token).toBeNull();
    expect(mockClearRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored refresh token on transient 5xx failure (audit A-020)', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-still-valid');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const token = await tryRefresh();
    expect(token).toBeNull();
    expect(mockClearRefreshToken).not.toHaveBeenCalled();
  });

  it('keeps the stored refresh token on 429 rate limit (audit A-020)', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-still-valid');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'RATE_LIMITED', message: 'too many' }), { status: 429 }),
    );
    const token = await tryRefresh();
    expect(token).toBeNull();
    expect(mockClearRefreshToken).not.toHaveBeenCalled();
  });

  it('keeps the stored refresh token on network error (audit A-020)', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-still-valid');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const token = await tryRefresh();
    expect(token).toBeNull();
    // NETWORK_ERROR is represented as ApiException(0, …). status 0 is not
    // in the "definitively rejected" range, so storage must survive.
    expect(mockClearRefreshToken).not.toHaveBeenCalled();
  });

  it('releases the coalescing slot after completion (next call re-fetches)', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ accessToken: 'at-1' }), { status: 200 }));

    await tryRefresh();
    await tryRefresh();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('authenticatedRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetRefreshToken.mockReset();
    mockStoreRefreshToken.mockReset();
    mockGetPlatform.mockReturnValue('web');
    useAuthStore.getState().clearSession();
  });

  it('throws UNAUTHORIZED when no token and no refresh token is stored', async () => {
    mockGetRefreshToken.mockResolvedValue(null);
    await expect(authenticatedRequest('/api/orders')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('uses the stored access token in the Authorization header', async () => {
    useAuthStore.getState().setAccessToken('at-memory');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/orders');

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at-memory');
    expect(headers['X-Client-Id']).toBe('loopweb');
  });

  it('attempts refresh when no token is in memory, then succeeds', async () => {
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // First call: the refresh
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'at-refreshed' }), { status: 200 }),
      )
      // Second call: the actual request
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await authenticatedRequest<{ ok: boolean }>('/api/orders');
    expect(res).toEqual({ ok: true });

    const secondCall = fetchSpy.mock.calls[1]!;
    const secondInit = secondCall[1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer at-refreshed',
    );
    expect(useAuthStore.getState().accessToken).toBe('at-refreshed');
  });

  it('refreshes and retries on 401, then succeeds', async () => {
    useAuthStore.getState().setAccessToken('at-stale');
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // First call: 401 with stale token
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), { status: 401 }),
      )
      // Second call: /api/auth/refresh
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'at-fresh' }), { status: 200 }),
      )
      // Third call: the retry
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await authenticatedRequest<{ ok: boolean }>('/api/orders');
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().accessToken).toBe('at-fresh');
  });

  it('clears the session and rethrows when refresh on 401 also fails', async () => {
    useAuthStore.getState().setAccessToken('at-stale');
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    vi.spyOn(globalThis, 'fetch')
      // First: 401
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), { status: 401 }),
      )
      // Refresh: also 401
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'revoked' }), { status: 401 }),
      );

    await expect(authenticatedRequest('/api/orders')).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('maps the native platform to the correct X-Client-Id', async () => {
    useAuthStore.getState().setAccessToken('at-memory');
    mockGetPlatform.mockReturnValue('ios');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/orders');

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toBe('loopios');
  });
});
