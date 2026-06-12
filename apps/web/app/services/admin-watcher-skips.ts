/**
 * Admin watcher-skips surface (ADR 037 §4 — skip-row browser).
 *
 * First read/ops surface over `payment_watcher_skips` (the rows the
 * payment watcher persisted before advancing its Horizon cursor —
 * comprehensive audit 2026-06-11 CRIT #1/#2):
 *
 * - `GET /api/admin/watcher-skips?status=&reason=&page=` — list.
 * - `GET /api/admin/watcher-skips/:paymentId` — detail (adds the
 *   snapshotted Horizon `payment` jsonb + `lastError`).
 * - `POST /api/admin/watcher-skips/:paymentId/reopen` — flips an
 *   abandoned row back to pending so the sweep re-evaluates it.
 *   Support-allowed (ADR 037 §3) but still carries an idempotency
 *   key per the uniform ADR 017 audit discipline.
 *
 * Wire shapes live in `@loop/shared/admin-watcher-skips.ts`.
 */
import type {
  AdminWatcherSkipDetail,
  AdminWatcherSkipReopenResult,
  AdminWatcherSkipsResponse,
  WatcherSkipReason,
  WatcherSkipStatus,
} from '@loop/shared';
import { generateIdempotencyKey } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/watcher-skips` — filterable, page-numbered list. */
export async function listWatcherSkips(
  opts: {
    status?: WatcherSkipStatus;
    reason?: WatcherSkipReason;
    page?: number;
  } = {},
): Promise<AdminWatcherSkipsResponse> {
  const params = new URLSearchParams();
  if (opts.status !== undefined) params.set('status', opts.status);
  if (opts.reason !== undefined) params.set('reason', opts.reason);
  if (opts.page !== undefined) params.set('page', String(opts.page));
  const qs = params.toString();
  return authenticatedRequest<AdminWatcherSkipsResponse>(
    `/api/admin/watcher-skips${qs.length > 0 ? `?${qs}` : ''}`,
  );
}

/** `GET /api/admin/watcher-skips/:paymentId` — single-row triage detail. */
export async function getWatcherSkip(paymentId: string): Promise<AdminWatcherSkipDetail> {
  return authenticatedRequest<AdminWatcherSkipDetail>(
    `/api/admin/watcher-skips/${encodeURIComponent(paymentId)}`,
  );
}

/**
 * `POST /api/admin/watcher-skips/:paymentId/reopen` — re-queue an
 * abandoned skip row for the replay sweep.
 */
export async function reopenWatcherSkip(paymentId: string): Promise<AdminWatcherSkipReopenResult> {
  return authenticatedRequest<AdminWatcherSkipReopenResult>(
    `/api/admin/watcher-skips/${encodeURIComponent(paymentId)}/reopen`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
    },
  );
}
