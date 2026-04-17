import type { VerifyOtpResponse } from '@loop/shared';
import { getPlatform } from '~/native/platform';
import { apiRequest } from './api-client';

/** Sends a verification code to the given email. */
export async function requestOtp(email: string): Promise<void> {
  await apiRequest<{ message: string }>('/api/auth/request-otp', {
    method: 'POST',
    body: { email, platform: getPlatform() },
  });
}

/**
 * Verifies the OTP. Returns { accessToken, refreshToken } for all clients.
 * The caller is responsible for storing the refresh token via secure-storage.
 */
export async function verifyOtp(email: string, otp: string): Promise<VerifyOtpResponse> {
  return apiRequest<VerifyOtpResponse>('/api/auth/verify-otp', {
    method: 'POST',
    body: { email, otp, platform: getPlatform() },
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
