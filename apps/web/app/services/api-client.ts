import { ApiException, DEFAULT_CLIENT_IDS } from '@loop/shared';
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
    // Upstream/backend errors are expected to be `{ code, message }`, but
    // proxies, intermediate gateways, and misconfigured servers can return
    // anything — HTML error pages, empty bodies, or JSON without our fields.
    // Normalize so `ApiException.code` and `.message` are always strings.
    let error: ApiError;
    try {
      const body = (await response.json()) as unknown;
      if (body !== null && typeof body === 'object') {
        const b = body as { code?: unknown; message?: unknown; details?: unknown };
        error = {
          code: typeof b.code === 'string' ? b.code : 'UPSTREAM_ERROR',
          message: typeof b.message === 'string' ? b.message : response.statusText,
          ...(b.details !== undefined && typeof b.details === 'object' && b.details !== null
            ? { details: b.details as Record<string, unknown> }
            : {}),
        };
      } else {
        error = { code: 'UPSTREAM_ERROR', message: response.statusText };
      }
    } catch {
      error = { code: 'UPSTREAM_ERROR', message: response.statusText };
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
 *
 * Exported so session-restore and any future caller can participate in the
 * same coalesced refresh — if two places both need a refreshed token at the
 * same moment, only one network round-trip should happen.
 *
 * Inlined here (not imported from services/auth) to avoid circular deps.
 */
export async function tryRefresh(): Promise<string | null> {
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
      // Await so a storage failure can't leave the rotated refresh token in
      // memory-only — next app load would then read the stale previous
      // token from storage and force a silent re-login.
      await storeRefreshToken(res.refreshToken);
    }
    return res.accessToken;
  } catch (err) {
    // Audit A-020: distinguish definitive rejection from transient failure.
    // Upstream returning 4xx (except 429 "too many requests") means the
    // refresh token is permanently dead — the user can't recover by
    // retrying later, so clearing storage now avoids N guaranteed-401s
    // on every subsequent startup. 5xx, 429, and network errors stay on
    // disk because the token might still be valid once upstream recovers.
    if (err instanceof ApiException) {
      const s = err.status;
      const definitivelyRejected = s >= 400 && s < 500 && s !== 429;
      if (definitivelyRejected) {
        const { clearRefreshToken } = await import('~/native/secure-storage');
        await clearRefreshToken();
      }
    }
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

  // Map platform to CTX client ID. `DEFAULT_CLIENT_IDS` in @loop/shared is
  // the single source of truth for these values — the backend's env
  // defaults and allowlist in `requireAuth()` read from the same constant,
  // so a rename propagates atomically and the backend warns if an env
  // override diverges from it (audit A-018).
  const platform = getPlatform();
  const clientId = DEFAULT_CLIENT_IDS[platform] ?? DEFAULT_CLIENT_IDS.web;

  // If no token in memory, try to refresh before the first attempt. Because
  // `tryRefresh` coalesces concurrent callers into a single underlying
  // request, parallel authenticated calls will all see the same new token.
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
