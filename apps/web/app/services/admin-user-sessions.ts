/**
 * Admin session-revocation client (hardening B4 / readiness-backlog
 * A5-2 — the endpoint shipped orphaned, curl-only).
 *
 * `POST /api/admin/users/:userId/revoke-sessions` — revokes every
 * live refresh token for the target user. The incident-response
 * lever for a compromised account: the session dies within at most
 * the 15-min access-token TTL (access tokens are non-revocable by
 * design).
 *
 * Unlike every other admin write in this directory, this endpoint
 * predates / deliberately opts out of the ADR 017 admin-write
 * envelope: no `Idempotency-Key` (the backend doesn't read one —
 * revoking an already-empty session set is naturally idempotent, no
 * synthetic snapshot needed), no `reason` body field (the handler
 * only reads `userId`), no `{ result, audit }` wrapper (flat
 * `{ userId, message }`), and — per the handler's own doc comment —
 * deliberately **not** step-up gated ("moves no value and is
 * reversible... gating it would add friction to a fast-response
 * security action"; see the exempt-list entry in
 * `staff-route-gating.test.ts`). This client matches that real
 * contract rather than imposing the envelope shape used elsewhere.
 */
import { authenticatedRequest } from './api-client';

/** Flat result from `POST /api/admin/users/:userId/revoke-sessions`. */
export interface AdminRevokeSessionsResult {
  userId: string;
  message: string;
}

export async function revokeUserSessions(userId: string): Promise<AdminRevokeSessionsResult> {
  return authenticatedRequest<AdminRevokeSessionsResult>(
    `/api/admin/users/${encodeURIComponent(userId)}/revoke-sessions`,
    { method: 'POST' },
  );
}
