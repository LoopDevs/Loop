import type { RequestOtpRequest, VerifyOtpRequest, VerifyOtpResponse } from '@loop/shared';
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

/**
 * Shape returned by the Loop-native auth endpoints. Social + OTP
 * converge on this — the client doesn't care which provider produced
 * the pair. Social responses include `email` because the client
 * never typed it (OTP knows it from the form).
 */
export interface LoopAuthPair {
  accessToken: string;
  refreshToken: string;
  email?: string;
}

/**
 * Exchanges a Google id_token (obtained on-device via the Google
 * Identity Services SDK) for a Loop access + refresh pair. The
 * backend verifies the id_token against Google's JWKS, enforces
 * audience + email_verified, then resolves or creates the Loop user
 * (ADR 014). See `/api/auth/social/google`.
 */
export async function socialLoginGoogle(idToken: string): Promise<LoopAuthPair> {
  return apiRequest<LoopAuthPair>('/api/auth/social/google', {
    method: 'POST',
    body: { idToken, platform: getPlatform() },
  });
}

/**
 * Exchanges an Apple id_token for a Loop access + refresh pair.
 * Same flow as Google; Apple's JWKS + issuer is checked on the
 * backend. See `/api/auth/social/apple`.
 */
export async function socialLoginApple(idToken: string): Promise<LoopAuthPair> {
  return apiRequest<LoopAuthPair>('/api/auth/social/apple', {
    method: 'POST',
    body: { idToken, platform: getPlatform() },
  });
}

/**
 * Signals logout to the server so it can revoke the refresh token upstream.
 * The caller is responsible for clearing local state regardless of whether
 * this call succeeds — if the backend can't reach CTX, we still want the
 * user signed out on-device.
 */
export async function logout(): Promise<void> {
  const { getRefreshToken } = await import('~/native/secure-storage');
  const refreshToken = await getRefreshToken();
  try {
    await apiRequest<{ message: string }>('/api/auth/session', {
      method: 'DELETE',
      // Only include refreshToken if we have one; backend accepts absence.
      body: {
        platform: getPlatform(),
        ...(refreshToken !== null ? { refreshToken } : {}),
      },
    });
  } catch {
    // Swallow — local clear in the caller (useAuth.logout) runs in finally.
  }
}
