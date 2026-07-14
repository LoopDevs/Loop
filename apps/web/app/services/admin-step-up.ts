/**
 * Admin step-up service (ADR 028, A4-063).
 *
 * `mintAdminStepUp(otp, scope)` calls `POST /api/admin/step-up` with the
 * admin's OTP and returns the short-lived, SINGLE-USE JWT. The OTP
 * itself is obtained via the existing `requestOtp` flow (`POST
 * /api/auth/request-otp`) which the admin already uses to log in — see
 * ADR-028 §Web flow for the rationale.
 *
 * SEC-02-stepup: `scope` is REQUIRED and binds the minted token to the
 * exact action-class the caller is about to perform. The token is
 * single-use and class-bound at the gate — a token minted for one class
 * cannot be replayed for another, nor used twice — so the client mints a
 * fresh, scoped token per protected write (never reusing one).
 */
import { authenticatedRequest } from './api-client';
import type { AdminStepUpScope } from '~/stores/admin-step-up.store';

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
export async function mintAdminStepUp(
  otp: string,
  scope: AdminStepUpScope,
): Promise<AdminStepUpResponse> {
  return authenticatedRequest<AdminStepUpResponse>('/api/admin/step-up', {
    method: 'POST',
    body: { otp, scope },
  });
}
