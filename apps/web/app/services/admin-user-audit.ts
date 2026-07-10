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
import type {
  AdminAuditTimelineCursors,
  AdminAuditTimelineEvent,
  AdminUserAuditTimelineResponse,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type { AdminAuditTimelineCursors, AdminAuditTimelineEvent, AdminUserAuditTimelineResponse };

/** Maps each per-source cursor to its `before*` query param name. */
const CURSOR_PARAM: Record<keyof AdminAuditTimelineCursors, string> = {
  adminActions: 'beforeAdminActions',
  ledger: 'beforeLedger',
  orders: 'beforeOrders',
  payouts: 'beforePayouts',
  sessions: 'beforeSessions',
};

/**
 * `GET /api/admin/users/:userId/audit` — newest-first, per-source
 * bounded. Pass `cursors` (the previous page's `nextCursors`) to page
 * older: each NON-null cursor pages ITS source; null/omitted cursors
 * are not re-queried (that source is exhausted). Omit `cursors`
 * entirely for page 1.
 */
export async function getAdminUserAuditTimeline(
  userId: string,
  opts: { limit?: number; cursors?: AdminAuditTimelineCursors | null } = {},
): Promise<AdminUserAuditTimelineResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.cursors !== null && opts.cursors !== undefined) {
    for (const key of Object.keys(CURSOR_PARAM) as Array<keyof AdminAuditTimelineCursors>) {
      const value = opts.cursors[key];
      if (value !== null) params.set(CURSOR_PARAM[key], value);
    }
  }
  const qs = params.toString();
  return authenticatedRequest<AdminUserAuditTimelineResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/audit${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
