import { ApiException } from '@loop/shared';
import type { ApiError } from '@loop/shared';
import { API_BASE } from './config';

// Browsers have no default fetch timeout. Without this, a backend that hangs
// (stuck upstream, bad network) would leave the UI spinning forever.
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** If true, returns an ArrayBuffer instead of parsing JSON. */
  binary?: boolean;
  /** Override the default request timeout (ms). Pass 0 to disable. */
  timeoutMs?: number;
  /** Pass-through AbortSignal for caller-controlled cancellation. */
  signal?: AbortSignal;
}

/**
 * Performs an authenticated or unauthenticated request to the Loop backend.
 * Throws ApiException on non-2xx responses.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    headers = {},
    binary = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: callerSignal,
  } = options;

  // Compose our timeout signal with the caller's signal if provided, so
  // either source of cancellation aborts the fetch.
  const signal =
    timeoutMs > 0
      ? callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      : callerSignal;

  const init: RequestInit = {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    // Translate aborts into a typed ApiException so callers can branch on
    // err.code === 'TIMEOUT' instead of fishing inside DOMException names.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiException(0, { code: 'TIMEOUT', message: 'Request timed out' });
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiException(0, { code: 'TIMEOUT', message: 'Request aborted' });
    }
    throw new ApiException(0, { code: 'NETWORK_ERROR', message: 'Network error' });
  }

  if (!response.ok) {
    let error: ApiError;
    try {
      error = (await response.json()) as ApiError;
    } catch {
      error = { code: 'NETWORK_ERROR', message: response.statusText };
    }
    throw new ApiException(response.status, error);
  }

  if (binary) {
    return response.arrayBuffer() as unknown as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Coalesces concurrent refresh attempts. Without this, N parallel authenticated
 * requests that each see a 401 would each POST /api/auth/refresh. The first
 * succeeds and rotates the refresh token upstream; the rest then fail with
 * 401 (stale token) and the UI ends up in a forced-logout state despite a
 * perfectly valid session having just been refreshed.
 */
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Attempts to get a fresh access token using the stored refresh token.
 * Returns the new access token or null on failure. Concurrent callers
 * share a single underlying refresh promise.
 * Inlined here (not imported from services/auth) to avoid circular deps.
 */
async function tryRefresh(): Promise<string | null> {
  if (inFlightRefresh !== null) return inFlightRefresh;

  inFlightRefresh = doRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefresh(): Promise<string | null> {
  const { getRefreshToken } = await import('~/native/secure-storage');
  const refreshToken = await getRefreshToken();
  if (refreshToken === null) return null;

  try {
    const { getPlatform } = await import('~/native/platform');
    const platform = getPlatform();

    const res = await apiRequest<{ accessToken: string; refreshToken?: string }>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body: { refreshToken, platform },
      },
    );
    if (res.refreshToken) {
      const { storeRefreshToken } = await import('~/native/secure-storage');
      void storeRefreshToken(res.refreshToken);
    }
    return res.accessToken;
  } catch {
    return null;
  }
}

/**
 * Performs an authenticated request by injecting the access token from the
 * auth store. If the token is absent or expired (401), attempts one silent
 * refresh before throwing.
 */
export async function authenticatedRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  // Lazy import to avoid circular deps and allow store to hydrate first
  const { useAuthStore } = await import('~/stores/auth.store');
  const { getPlatform } = await import('~/native/platform');
  const store = useAuthStore.getState();
  let token = store.accessToken;

  // Map platform to CTX client ID
  const platform = getPlatform();
  const clientIdMap = { web: 'loopweb', ios: 'loopios', android: 'loopandroid' } as const;
  const clientId = clientIdMap[platform] ?? 'loopweb';

  // If no token in memory, try to refresh before the first attempt.
  // Use the freshest store reference for the write so we never overwrite a
  // token that was set by another refresh that resolved while we awaited.
  if (token === null) {
    token = await tryRefresh();
    if (token !== null) {
      useAuthStore.getState().setAccessToken(token);
    } else {
      throw new ApiException(401, { code: 'UNAUTHORIZED', message: 'Not authenticated' });
    }
  }

  try {
    return await apiRequest<T>(path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}`, 'X-Client-Id': clientId },
    });
  } catch (err) {
    // On 401, attempt one silent refresh and retry
    if (err instanceof ApiException && err.status === 401) {
      const newToken = await tryRefresh();
      if (newToken !== null) {
        useAuthStore.getState().setAccessToken(newToken);
        return apiRequest<T>(path, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
            'X-Client-Id': clientId,
          },
        });
      }
      // Refresh also failed — clear stale session
      useAuthStore.getState().clearSession();
    }
    throw err;
  }
}
