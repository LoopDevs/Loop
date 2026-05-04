/**
 * Admin step-up service (ADR 028, A4-063).
 *
 * `mintAdminStepUp(otp)` calls `POST /api/admin/step-up` with the
 * admin's OTP and returns the short-lived JWT. The OTP itself is
 * obtained via the existing `requestOtp` flow (`POST
 * /api/auth/request-otp`) which the admin already uses to log in —
 * see ADR-028 §Web flow for the rationale.
 */
import { authenticatedRequest } from './api-client';

export interface AdminStepUpResponse {
  stepUpToken: string;
  /** ISO timestamp; the JWT is signed for 5 min. */
  expiresAt: string;
}

/**
 * Calls `POST /api/admin/step-up`. Throws an `ApiException` on
 * non-2xx; callers handle 401 (wrong OTP), 503 (key not configured
 * server-side), and 500.
 */
export async function mintAdminStepUp(otp: string): Promise<AdminStepUpResponse> {
  return authenticatedRequest<AdminStepUpResponse>('/api/admin/step-up', {
    method: 'POST',
    body: { otp },
  });
}
