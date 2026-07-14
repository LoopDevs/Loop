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

import { apiRequest, authenticatedRequest, tryRefresh, onSessionExpired } from '../api-client';
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

  it('A2-1529: stamps X-Client-Version on every request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await apiRequest('/api/merchants');
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Client-Version']).toBeDefined();
    expect(headers['X-Client-Version']).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('A2-1529: caller-provided X-Client-Version overrides the default (test seam)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await apiRequest('/api/merchants', { headers: { 'X-Client-Version': '9.9.9' } });
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Client-Version']).toBe('9.9.9');
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

/**
 * Q6-3: ADR-028 admin step-up header plumbing. `authenticatedRequest`
 * is the one place that reads the held step-up JWT out of
 * `useAdminStepUpStore` and turns it into `X-Admin-Step-Up` — every
 * admin writer (`applyCreditAdjustment`, `redriveOrder`, `retryPayout`,
 * …) just passes `withStepUp: true` and trusts this layer to do the
 * header plumbing correctly.
 */
describe('authenticatedRequest — admin step-up header (ADR 028)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockGetRefreshToken.mockReset();
    mockGetPlatform.mockReturnValue('web');
    useAuthStore.getState().clearSession();
    useAuthStore.getState().setAccessToken('at-memory');
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    useAdminStepUpStore.getState().clear();
  });

  it('attaches X-Admin-Step-Up when withStepUp is true and the store holds a fresh token', async () => {
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    useAdminStepUpStore.getState().setStepUp('fresh-step-up-jwt', futureExp);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
      method: 'POST',
      withStepUp: true,
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Admin-Step-Up']).toBe('fresh-step-up-jwt');
  });

  it('does NOT attach X-Admin-Step-Up when withStepUp is not set, even if the store holds a token', async () => {
    // Guards against the header leaking onto a non-gated write (e.g.
    // revoke-sessions) just because a step-up token happens to be held
    // in memory from an earlier, unrelated admin action.
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    useAdminStepUpStore.getState().setStepUp('fresh-step-up-jwt', futureExp);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/admin/users/u1/revoke-sessions', { method: 'POST' });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Admin-Step-Up']).toBeUndefined();
  });

  it('sends no X-Admin-Step-Up value when withStepUp is true but the store is empty (server drives the 401)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'STEP_UP_REQUIRED', message: 'step-up required' }), {
        status: 401,
      }),
    );
    mockGetRefreshToken.mockResolvedValue(null);

    await expect(
      authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
        method: 'POST',
        withStepUp: true,
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Admin-Step-Up']).toBeUndefined();
  });

  it('preserves the step-up header across the silent access-token-refresh retry path', async () => {
    // A step-up-gated call can also race a stale/expired access token.
    // If that happens mid-flow, the refresh-and-retry path must not
    // silently drop X-Admin-Step-Up on the retried request.
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    useAdminStepUpStore.getState().setStepUp('fresh-step-up-jwt', futureExp);
    mockGetRefreshToken.mockResolvedValue('rt-stored');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // First call: 401 with a stale access token (not a step-up rejection)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), {
          status: 401,
        }),
      )
      // Second call: /api/auth/refresh
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'at-fresh' }), { status: 200 }),
      )
      // Third call: the retry
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
      method: 'POST',
      withStepUp: true,
    });

    const retryInit = fetchSpy.mock.calls[2]![1] as RequestInit;
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders['X-Admin-Step-Up']).toBe('fresh-step-up-jwt');
    expect(retryHeaders.Authorization).toBe('Bearer at-fresh');
  });
});

/**
 * FE-40: centralized session-expiry handler. When an authenticated
 * request's session is definitively dead (a 401 whose silent refresh
 * also fails), the transport emits a session-expiry event so the app
 * can render a "sign in again" re-auth prompt — instead of leaving each
 * call site to surface a generic error. Step-up 401s (STEP_UP_*) are
 * exempt: they own their own re-auth flow and must not be hijacked.
 */
describe('authenticatedRequest — session-expiry handler (FE-40)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockGetRefreshToken.mockReset();
    mockStoreRefreshToken.mockReset();
    mockClearRefreshToken.mockReset();
    mockGetPlatform.mockReturnValue('web');
    useAuthStore.getState().clearSession();
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    useAdminStepUpStore.getState().clear();
  });

  it('fires the session-expiry handler when a 401 refresh also fails (not a generic error)', async () => {
    useAuthStore.getState().setAccessToken('at-stale');
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    vi.spyOn(globalThis, 'fetch')
      // First: 401 with a stale access token
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), {
          status: 401,
        }),
      )
      // Refresh: also 401 → refresh token is dead → session is gone
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'revoked' }), {
          status: 401,
        }),
      );

    const onExpired = vi.fn();
    const unsubscribe = onSessionExpired(onExpired);
    try {
      await expect(authenticatedRequest('/api/orders/loop')).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      unsubscribe();
    }

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    // Session was torn down as part of the same path.
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('does NOT fire the session-expiry handler for a step-up 401 (own re-auth flow)', async () => {
    useAuthStore.getState().setAccessToken('at-memory');
    // Null refresh token so tryRefresh returns null and control reaches
    // the same session-teardown branch the genuine-expiry case hits —
    // proving the exemption is the STEP_UP_REQUIRED code, not a
    // different code path.
    mockGetRefreshToken.mockResolvedValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'STEP_UP_REQUIRED', message: 'step-up required' }), {
        status: 401,
      }),
    );

    const onExpired = vi.fn();
    const unsubscribe = onSessionExpired(onExpired);
    try {
      await expect(
        authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
          method: 'POST',
          withStepUp: true,
        }),
      ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    } finally {
      unsubscribe();
    }

    expect(onExpired).not.toHaveBeenCalled();
  });

  it('unsubscribe() stops further session-expiry notifications', async () => {
    useAuthStore.getState().setAccessToken('at-stale');
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), { status: 401 }),
    );

    const onExpired = vi.fn();
    onSessionExpired(onExpired)(); // subscribe then immediately unsubscribe

    await expect(authenticatedRequest('/api/orders/loop')).rejects.toMatchObject({ status: 401 });
    expect(onExpired).not.toHaveBeenCalled();
  });
});

/**
 * FE-06: a step-up 401 challenge (STEP_UP_*) must NOT be misclassified as
 * an access-token expiry. The backend runs `requireAuth` before the
 * step-up gate, so a STEP_UP_* code proves the access token was valid —
 * routing it through the refresh-and-retry path burns a round-trip,
 * needlessly rotates the refresh token, and (if that refresh transiently
 * fails) tears down a live admin session. It must surface unchanged so the
 * step-up flow handles it. Distinct from FE-40 (which exempted only the
 * session-expiry EMIT); FE-06 exempts the refresh itself.
 */
describe('authenticatedRequest — step-up 401 is not a token-expiry (FE-06)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockGetRefreshToken.mockReset();
    mockStoreRefreshToken.mockReset();
    mockClearRefreshToken.mockReset();
    mockGetPlatform.mockReturnValue('web');
    useAuthStore.getState().clearSession();
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    useAdminStepUpStore.getState().clear();
  });

  it('does NOT refresh the access token or clear the session on a step-up 401', async () => {
    useAuthStore.getState().setAccessToken('at-live');
    // A refresh token IS available: if the (buggy) refresh path runs, it
    // will fetch /api/auth/refresh. Proving it doesn't proves the step-up
    // 401 is classified as a challenge, not an access-token expiry.
    mockGetRefreshToken.mockResolvedValue('rt-stored');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // The gated admin write is answered with a step-up challenge.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'STEP_UP_REQUIRED', message: 'step-up required' }), {
          status: 401,
        }),
      )
      // Only reachable if the code wrongly refreshes: a fresh access token…
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'at-fresh' }), { status: 200 }),
      )
      // …then the wrong retry, which would 401 on step-up again.
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'STEP_UP_REQUIRED', message: 'still' }), {
          status: 401,
        }),
      );

    await expect(
      authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
        method: 'POST',
        withStepUp: true,
      }),
    ).rejects.toMatchObject({ status: 401, code: 'STEP_UP_REQUIRED' });

    // The challenge surfaced directly: exactly ONE fetch (the write), no
    // /api/auth/refresh round-trip.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The refresh path never even read the stored refresh token.
    expect(mockGetRefreshToken).not.toHaveBeenCalled();
    // The live admin session is intact — not torn down.
    expect(useAuthStore.getState().accessToken).toBe('at-live');
  });

  it('still refreshes and retries a genuine access-expiry 401 (UNAUTHORIZED)', async () => {
    // Guards against an over-broad fix that skips refresh for ALL 401s.
    useAuthStore.getState().setAccessToken('at-stale');
    mockGetRefreshToken.mockResolvedValue('rt-stored');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired' }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'at-fresh' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await authenticatedRequest<{ ok: boolean }>('/api/orders');
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().accessToken).toBe('at-fresh');
  });
});

/**
 * FE-07: the cached step-up token is reused ONLY while the store's
 * `isFresh()` guard vouches for it. A stale-but-not-yet-expired token
 * (inside the 5s freshness skew) must be dropped so a fresh challenge is
 * forced, rather than replayed into a guaranteed mid-flight 401. This wires
 * the previously-dead `isFresh()` guard into the reuse gate (fail-closed).
 */
describe('authenticatedRequest — step-up freshness gate (FE-07)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockGetRefreshToken.mockReset();
    mockGetPlatform.mockReturnValue('web');
    useAuthStore.getState().clearSession();
    useAuthStore.getState().setAccessToken('at-memory');
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    useAdminStepUpStore.getState().clear();
  });

  it('does NOT reuse a stale (within-skew, not-yet-expired) cached step-up token', async () => {
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    // exp is 2s in the future: past the store's 5s freshness skew but not
    // yet expired by raw `exp`. isFresh() is false while the raw token is
    // non-null/non-empty (all the old gate checked), so an unguarded reuse
    // would replay this into a guaranteed mid-flight 401.
    const nearExp = new Date(Date.now() + 2_000).toISOString();
    useAdminStepUpStore.getState().setStepUp('stale-but-unexpired-jwt', nearExp);
    // Sanity: this token IS stale by the freshness guard.
    expect(useAdminStepUpStore.getState().isFresh()).toBe(false);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
      method: 'POST',
      withStepUp: true,
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // Fail closed: the stale token is dropped, forcing a fresh challenge.
    expect(headers['X-Admin-Step-Up']).toBeUndefined();
  });

  it('still reuses a genuinely fresh cached step-up token', async () => {
    // Guards against an over-broad fix that drops every cached token.
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    useAdminStepUpStore.getState().setStepUp('fresh-jwt', futureExp);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await authenticatedRequest('/api/admin/users/u1/credit-adjustments', {
      method: 'POST',
      withStepUp: true,
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Admin-Step-Up']).toBe('fresh-jwt');
  });
});
