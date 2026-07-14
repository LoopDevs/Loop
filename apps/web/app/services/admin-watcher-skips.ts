/**
 * Admin watcher-skips surface (ADR 037 §4 — skip-row browser).
 *
 * First read/ops surface over `payment_watcher_skips` (the rows the
 * payment watcher persisted before advancing its Horizon cursor —
 * comprehensive audit 2026-06-11 CRIT #1/#2):
 *
 * - `GET /api/admin/watcher-skips?status=&reason=&limit=&before=` —
 *   keyset-paginated list, newest first (same `before` convention as
 *   `/api/admin/orders` — pass the last row's `createdAt` to page).
 * - `GET /api/admin/watcher-skips/:paymentId` — detail (adds the
 *   snapshotted Horizon `payment` jsonb).
 * - `POST /api/admin/watcher-skips/:paymentId/reopen` — flips an
 *   abandoned row back to pending so the sweep re-evaluates it.
 *   Support-allowed (ADR 037 §3) but carries the full ADR 017
 *   contract: idempotency key + 2..500 char reason in the body,
 *   `{ result, audit }` envelope back. A row that isn't abandoned
 *   409s (`SKIP_NOT_ABANDONED`).
 *
 * Wire shapes live in `@loop/shared/admin-support-ops.ts`.
 */
import type {
  AdminWatcherSkipDetail,
  AdminWatcherSkipReopenResult,
  AdminWatcherSkipsListResponse,
  WatcherSkipReason,
  WatcherSkipStatus,
} from '@loop/shared';
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `GET /api/admin/watcher-skips` — filterable keyset list. */
export async function listWatcherSkips(
  opts: {
    status?: WatcherSkipStatus;
    reason?: WatcherSkipReason;
    /** ISO-8601 keyset cursor — returns rows strictly older than this. */
    before?: string;
    /** 1–100; backend default 20. */
    limit?: number;
  } = {},
): Promise<AdminWatcherSkipsListResponse> {
  const params = new URLSearchParams();
  if (opts.status !== undefined) params.set('status', opts.status);
  if (opts.reason !== undefined) params.set('reason', opts.reason);
  if (opts.before !== undefined) params.set('before', opts.before);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminWatcherSkipsListResponse>(
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
export async function reopenWatcherSkip(args: {
  paymentId: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminWatcherSkipReopenResult>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminWatcherSkipReopenResult>>(
    `/api/admin/watcher-skips/${encodeURIComponent(args.paymentId)}/reopen`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
    },
  );
}

export interface DepositRefundResult {
  paymentId: string;
  status: 'refunded' | 'already_refunded';
  txHash: string;
}

/**
 * A6: refund an abandoned late deposit back to its on-chain sender.
 * `POST /api/admin/deposits/:paymentId/refund` — admin-tier + step-up
 * (`withStepUp` runs the ADR-028 dance). Full ADR-017 admin-write
 * contract (mirrors `refundOrder`): a required `Idempotency-Key`
 * header (defaulted per-call, or pass `idempotencyKey` to reuse one
 * verbatim across a step-up retry — CF-09) and a required 2..500 char
 * `reason` body field; returns the `{ result, audit }` envelope. A
 * same-key replay returns the stored snapshot (`already_refunded`),
 * so a step-up retry / re-click never double-pays.
 */
export async function refundDeposit(args: {
  paymentId: string;
  reason: string;
  idempotencyKey?: string;
}): Promise<AdminWriteEnvelope<DepositRefundResult>> {
  return authenticatedRequest<AdminWriteEnvelope<DepositRefundResult>>(
    `/api/admin/deposits/${encodeURIComponent(args.paymentId)}/refund`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': args.idempotencyKey ?? generateIdempotencyKey() },
      body: { reason: args.reason },
      // ADR-028 / A4-063: gated by step-up auth.
      withStepUp: true,
    },
  );
}
