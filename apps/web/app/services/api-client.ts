import { ApiException, DEFAULT_CLIENT_IDS } from '@loop/shared';
import type { RefreshRequest } from '@loop/shared';
import { API_BASE } from './config';
import { parseErrorResponse } from './parse-error-response';

// Browsers have no default fetch timeout. Without this, a backend that hangs
// (stuck upstream, bad network) would leave the UI spinning forever.
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A2-1529: client version stamped on every outbound request as
 * `X-Client-Version`. Baked in at build time from `package.json`
 * (see `vite.config.ts`). Backend access-log ties each request to a
 * specific client build, so a prod regression can be scoped ("only
 * clients ≥ 0.3.1 hit the bug") without Sentry forensics.
 *
 * Platform is known at runtime (`getPlatform()`) — `web`, `ios`,
 * `android`. `X-Client-Platform` gives ops a quick Grafana filter
 * without inferring it from the User-Agent.
 */
const CLIENT_VERSION =
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined' &&
    (import.meta.env['VITE_CLIENT_VERSION'] as string | undefined)) ||
  '0.0.0';

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
  /**
   * ADR-028 / A4-063: opt in to the admin step-up gate. When true,
   * `authenticatedRequest` reads the held step-up token from
   * `useAdminStepUpStore` and adds it as `X-Admin-Step-Up`. The
   * mutation hook (`withAdminStepUp` in
   * `apps/web/app/hooks/use-admin-step-up.ts`) is responsible for
   * minting a fresh token before this call when the store is
   * empty / expired.
   */
  withStepUp?: boolean;
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

  // A2-1529: X-Client-Version on every outbound request. Callers can
  // still override via `headers` if they need to; the spread places
  // theirs after so per-caller wins on conflict.
  const init: RequestInit = {
    method,
    headers: {
      'X-Client-Version': CLIENT_VERSION,
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
    // A2-1162: body-shape normalisation lives in `parse-error-response.ts`
    // so this file + `clusters.ts` share one definition instead of the
    // previous byte-for-byte duplicate. See that file for the defensive-
    // coerce rationale (HTML error pages, empty bodies, JSON without our
    // fields all land here).
    const error = await parseErrorResponse(response);
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

    const body: RefreshRequest = { refreshToken, platform };
    const res = await apiRequest<{ accessToken: string; refreshToken?: string }>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body,
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
    //
    // A4-060: log the upstream rejection code (USER_DEACTIVATED,
    // INVALID_REFRESH_TOKEN, EXPIRED_OTP, etc.) so a deactivation
    // event isn't indistinguishable from a network blip in Sentry
    // breadcrumbs / dev console. The function still returns null
    // because the wire contract is "fresh access token or null"
    // — surface-level UX differentiation is a follow-up that
    // would change this signature.
    if (err instanceof ApiException) {
      const s = err.status;
      const definitivelyRejected = s >= 400 && s < 500 && s !== 429;
      // eslint-disable-next-line no-console
      console.warn(
        `auth.refresh: ${definitivelyRejected ? 'definitive' : 'transient'} rejection — code=${err.code} status=${s}`,
      );
      if (definitivelyRejected) {
        const { clearRefreshToken } = await import('~/native/secure-storage');
        await clearRefreshToken();
      }
    } else if (err instanceof Error) {
      // eslint-disable-next-line no-console
      console.warn(`auth.refresh: non-API failure — ${err.message}`);
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

  // ADR-028 / A4-063: opt-in step-up header. The mutation hook
  // mints / refreshes the token; this layer just plumbs it through.
  // If the caller asked for step-up but the store is empty, pass an
  // empty string — the backend rejects empty / missing equally with
  // 401 STEP_UP_REQUIRED, which the mutation hook handles by
  // prompting the modal and retrying.
  let stepUpHeader: Record<string, string> = {};
  if (options.withStepUp === true) {
    const { useAdminStepUpStore } = await import('~/stores/admin-step-up.store');
    const stepUpToken = useAdminStepUpStore.getState().token;
    if (stepUpToken !== null && stepUpToken.length > 0) {
      stepUpHeader = { 'X-Admin-Step-Up': stepUpToken };
    }
  }

  try {
    return await apiRequest<T>(path, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
        'X-Client-Id': clientId,
        ...stepUpHeader,
      },
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
            ...stepUpHeader,
          },
        });
      }
      // Refresh also failed — clear stale session
      useAuthStore.getState().clearSession();
    }
    throw err;
  }
}
