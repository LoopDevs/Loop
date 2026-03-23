import { ApiException } from '@loop/shared';
import type { ApiError } from '@loop/shared';
import { API_BASE } from './config';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** If true, returns an ArrayBuffer instead of parsing JSON. */
  binary?: boolean;
}

/**
 * Performs an authenticated or unauthenticated request to the Loop backend.
 * Throws ApiException on non-2xx responses.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, binary = false } = options;

  const init: RequestInit = {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetch(`${API_BASE}${path}`, init);

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
 * Attempts to get a fresh access token using the stored refresh token.
 * Returns the new access token or null on failure.
 * Inlined here (not imported from services/auth) to avoid circular deps.
 */
async function tryRefresh(): Promise<string | null> {
  const { getRefreshToken } = await import('~/native/secure-storage');
  const refreshToken = await getRefreshToken();
  if (refreshToken === null) return null;

  try {
    const res = await apiRequest<{ accessToken: string; refreshToken?: string }>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body: { refreshToken },
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
  const store = useAuthStore.getState();
  let token = store.accessToken;

  // If no token in memory, try to refresh before the first attempt
  if (token === null) {
    token = await tryRefresh();
    if (token !== null) {
      store.setAccessToken(token);
    } else {
      throw new ApiException(401, { code: 'UNAUTHORIZED', message: 'Not authenticated' });
    }
  }

  try {
    return await apiRequest<T>(path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    // On 401, attempt one silent refresh and retry
    if (err instanceof ApiException && err.status === 401) {
      const newToken = await tryRefresh();
      if (newToken !== null) {
        useAuthStore.getState().setAccessToken(newToken);
        return apiRequest<T>(path, {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${newToken}` },
        });
      }
    }
    throw err;
  }
}
