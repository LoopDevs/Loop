/**
 * A2-1165 (slice 2): admin audit-tail types + read extracted from
 * `services/admin.ts`. The audit-tail surface (`/api/admin/audit-tail`)
 * is the newest-first newline of `admin_idempotency_keys` rows
 * (ADR 017 / 018) — surfaced on the admin landing page's "recent
 * admin activity" card and the standalone `/admin/audit` page.
 *
 * `services/admin.ts` keeps the re-export so existing consumers
 * (`AdminAuditTail.tsx`, `routes/admin.audit.tsx`, both paired
 * tests) don't have to re-target imports in the same PR.
 */
import { authenticatedRequest } from './api-client';

/**
 * One row from the admin audit tail (ADR 017 / 018). Mirrors the
 * Discord audit message: who did what, when, status. Response body
 * is intentionally omitted — audit is "activity happened" not
 * "here's the prior payload".
 */
export interface AdminAuditTailRow {
  actorUserId: string;
  actorEmail: string;
  method: string;
  path: string;
  status: number;
  createdAt: string;
}

export interface AdminAuditTailResponse {
  rows: AdminAuditTailRow[];
}

/**
 * `GET /api/admin/audit-tail` — newest-first tail of
 * `admin_idempotency_keys`. Admin landing surfaces this as a
 * "recent admin activity" card; the standalone `/admin/audit` page
 * passes `before` to page older rows past the endpoint's 100-row
 * cap.
 */
export async function getAdminAuditTail(
  opts: { limit?: number; before?: string } | number = {},
): Promise<AdminAuditTailResponse> {
  // Back-compat: callers passing a raw number (the original signature,
  // still used by AdminAuditTail on the landing page) keep working.
  const resolved = typeof opts === 'number' ? { limit: opts } : opts;
  const params = new URLSearchParams();
  if (resolved.limit !== undefined) params.set('limit', String(resolved.limit));
  if (resolved.before !== undefined) params.set('before', resolved.before);
  const qs = params.toString();
  return authenticatedRequest<AdminAuditTailResponse>(
    `/api/admin/audit-tail${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
