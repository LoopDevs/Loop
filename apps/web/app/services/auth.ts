import type { VerifyOtpResponse, RefreshResponse } from '@loop/shared';
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

/** Exchanges a refresh token for a new access token. */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshResponse> {
  return apiRequest<RefreshResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken, platform: getPlatform() },
  });
}

/** Signals logout to the server (client clears stored tokens separately). */
export async function logout(): Promise<void> {
  await apiRequest<{ message: string }>('/api/auth/session', {
    method: 'DELETE',
  });
}
