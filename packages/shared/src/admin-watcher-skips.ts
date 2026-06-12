/**
 * `/api/admin/watcher-skips*` wire shapes (ADR 037 — support
 * dashboard view 4).
 *
 * The payment watcher persists every skipped Horizon payment to
 * `payment_watcher_skips` before advancing its cursor (comprehensive
 * audit 2026-06-11 CRIT #1/#2); this is the first read/ops surface
 * over that table. Reason and status unions mirror the table's CHECK
 * constraints (`apps/backend/src/db/schema.ts`).
 */

/** CHECK-constrained skip reasons (`payment_watcher_skips_reason_known`). */
export type WatcherSkipReason =
  | 'asset_mismatch'
  | 'amount_insufficient'
  | 'missing_credit_row'
  | 'processing_error';

/** CHECK-constrained lifecycle (`payment_watcher_skips_status_known`). */
export type WatcherSkipStatus = 'pending' | 'resolved' | 'abandoned';

/** One row of `GET /api/admin/watcher-skips`. */
export interface AdminWatcherSkipRow {
  /** Horizon operation id — stable replay key. */
  paymentId: string;
  memo: string;
  /** Null when the memo never matched an order. */
  orderId: string | null;
  reason: WatcherSkipReason;
  attempts: number;
  status: WatcherSkipStatus;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/admin/watcher-skips?status=&reason=&page=` */
export interface AdminWatcherSkipsResponse {
  skips: AdminWatcherSkipRow[];
}

/**
 * `GET /api/admin/watcher-skips/:paymentId` — the row plus the
 * snapshotted Horizon payment (jsonb summary) and the last replay
 * error, for deep triage.
 */
export interface AdminWatcherSkipDetail extends AdminWatcherSkipRow {
  /** Parsed-Horizon-record snapshot the retry sweep replays. */
  payment: Record<string, unknown>;
  lastError: string | null;
}

/**
 * `POST /api/admin/watcher-skips/:paymentId/reopen` — flips an
 * abandoned row back to `pending` so the sweep re-evaluates it. A
 * support-allowed delivery-unsticking action (ADR 037 §3).
 */
export interface AdminWatcherSkipReopenResult {
  reopened: boolean;
}
