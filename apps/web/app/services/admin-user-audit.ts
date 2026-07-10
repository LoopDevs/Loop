/**
 * Per-subject admin audit timeline (ADR 037 §4 / A5-7):
 *
 * - `GET /api/admin/users/:userId/audit` — merges admin actions
 *   targeting this user + their credit-transactions / orders /
 *   payouts / session-revocation history into one newest-first,
 *   time-ordered view. Complements the per-user credit-transactions
 *   panel (`./admin-user-credits.ts`) and the fleet-wide ledger
 *   browser (`./admin-ledger.ts`) — this one answers "what happened
 *   to this account, across every surface" in one page instead of
 *   five.
 *
 * Read-only — no write function in this module by design.
 *
 * Wire shape lives in `@loop/shared/admin-support-ops.ts`.
 */
import type { AdminAuditTimelineEvent, AdminUserAuditTimelineResponse } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { AdminAuditTimelineEvent, AdminUserAuditTimelineResponse };

/** `GET /api/admin/users/:userId/audit` — newest-first, per-source bounded. */
export async function getAdminUserAuditTimeline(
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<AdminUserAuditTimelineResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before !== undefined) params.set('before', opts.before);
  const qs = params.toString();
  return authenticatedRequest<AdminUserAuditTimelineResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/audit${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
