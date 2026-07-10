/**
 * Login/OTP support state (readiness-backlog A5-3):
 *
 * - `GET /api/admin/users/:userId/auth-state` — read-only B5 lockout
 *   state + OTP request/verify history + live-session count.
 *   Support-tier.
 * - `POST /api/admin/users/:userId/clear-otp-lockout` — clears the B5
 *   lockout counter (the same primitive a successful verify-otp uses).
 *   Admin-tier — NOT step-up-gated, but DOES carry the ADR-017-lite
 *   contract (Idempotency-Key + 2..500 char reason, `{ result, audit }`
 *   back), unlike the plainer `revoke-sessions` in `./admin-user-sessions.ts`.
 *   See `apps/backend/src/admin/clear-otp-lockout.ts` for the tier
 *   reasoning.
 *
 * Wire shapes live in `@loop/shared/admin-support-ops.ts`.
 */
import type { AdminClearOtpLockoutResult, AdminUserAuthStateResponse } from '@loop/shared';
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/users/:userId/auth-state` */
export async function getAdminUserAuthState(userId: string): Promise<AdminUserAuthStateResponse> {
  return authenticatedRequest<AdminUserAuthStateResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/auth-state`,
  );
}

/** `POST /api/admin/users/:userId/clear-otp-lockout` */
export async function clearAdminOtpLockout(args: {
  userId: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminClearOtpLockoutResult>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminClearOtpLockoutResult>>(
    `/api/admin/users/${encodeURIComponent(args.userId)}/clear-otp-lockout`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
    },
  );
}
