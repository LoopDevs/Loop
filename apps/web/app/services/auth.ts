import type {
  RequestOtpRequest,
  SocialLoginResponse,
  VerifyOtpRequest,
  VerifyOtpResponse,
} from '@loop/shared';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';
import { getPlatform } from '~/native/platform';
import { apiRequest } from './api-client';

/** Sends a verification code to the given email. */
export async function requestOtp(email: string): Promise<void> {
  const body: RequestOtpRequest = { email, platform: getPlatform() };
  await apiRequest<{ message: string }>('/api/auth/request-otp', {
    method: 'POST',
    body,
  });
}

/**
 * Verifies the OTP. Returns { accessToken, refreshToken } for all clients.
 * The caller is responsible for storing the refresh token via secure-storage.
 */
export async function verifyOtp(email: string, otp: string): Promise<VerifyOtpResponse> {
  const body: VerifyOtpRequest = { email, otp, platform: getPlatform() };
  return apiRequest<VerifyOtpResponse>('/api/auth/verify-otp', {
    method: 'POST',
    body,
  });
}

// SocialLoginResponse (accessToken + refreshToken + email: string) is now
// the single source of truth from @loop/shared (packages/shared/src/api.ts —
// ADR 019). Re-exported as LoopAuthPair so existing callers keep resolving.
export type { SocialLoginResponse };
/** @deprecated Use SocialLoginResponse from @loop/shared instead. */
export type LoopAuthPair = SocialLoginResponse;

/**
 * Exchanges a Google id_token (obtained on-device via the Google
 * Identity Services SDK) for a Loop access + refresh pair. The
 * backend verifies the id_token against Google's JWKS, enforces
 * audience + email_verified, then resolves or creates the Loop user
 * (ADR 014). See `/api/auth/social/google`.
 */
export async function socialLoginGoogle(idToken: string): Promise<SocialLoginResponse> {
  return apiRequest<SocialLoginResponse>('/api/auth/social/google', {
    method: 'POST',
    body: { idToken, platform: getPlatform() },
  });
}

/**
 * Exchanges an Apple id_token for a Loop access + refresh pair.
 * Same flow as Google; Apple's JWKS + issuer is checked on the
 * backend. See `/api/auth/social/apple`.
 */
export async function socialLoginApple(idToken: string): Promise<SocialLoginResponse> {
  return apiRequest<SocialLoginResponse>('/api/auth/social/apple', {
    method: 'POST',
    body: { idToken, platform: getPlatform() },
  });
}

/**
 * Signals logout to the server so it can revoke the session server-side.
 * Two credentials ride on the request, each for a different revoke:
 * the `Authorization` bearer drives the upstream CTX revoke (CTX's
 * `POST /logout` authenticates by access token + `X-Client-Id`, no
 * body), and the body `refreshToken` drives the Loop-native row
 * revoke (the backend needs its `jti`; an access token carries none).
 *
 * An expired bearer is rolled first so upstream receives a live token
 * to kill; the refresh token is read AFTER that roll so the body
 * carries the current row, not one the roll just rotated out.
 *
 * The caller is responsible for clearing local state regardless of
 * whether this call succeeds — if the backend can't reach CTX, we
 * still want the user signed out on-device.
 */
export async function logout(): Promise<void> {
  const { useAuthStore } = await import('~/stores/auth.store');
  const { isJwtExpired } = await import('~/utils/jwt-expiry');
  const { tryRefresh } = await import('./api-client');

  let accessToken = useAuthStore.getState().accessToken;
  if (accessToken === null || isJwtExpired(accessToken)) {
    // null on failure — the request below then goes bearer-less and the
    // backend skips the upstream revoke (nothing live to revoke with).
    accessToken = await tryRefresh();
  }

  const { getRefreshToken } = await import('~/native/secure-storage');
  const refreshToken = await getRefreshToken();

  const platform = getPlatform();
  const clientId = DEFAULT_CLIENT_IDS[platform] ?? DEFAULT_CLIENT_IDS.web;
  try {
    await apiRequest<{ message: string }>('/api/auth/session', {
      method: 'DELETE',
      body: {
        platform,
        ...(refreshToken !== null ? { refreshToken } : {}),
      },
      headers:
        accessToken !== null
          ? { Authorization: `Bearer ${accessToken}`, 'X-Client-Id': clientId }
          : {},
    });
  } catch {
    // Swallow — local clear in the caller (useAuth.logout) runs in finally.
  }
}

/**
 * B4: "Sign out of all devices" — revokes every live refresh token for
 * the caller server-side, so a stolen refresh token on another device
 * is killed. Authenticated call; the caller clears local state after.
 */
export async function signOutAllDevices(): Promise<void> {
  const { authenticatedRequest } = await import('./api-client');
  await authenticatedRequest<{ message: string }>('/api/auth/session/all', {
    method: 'DELETE',
  });
}
