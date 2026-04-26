/**
 * A2-1165 (slice 16): the ADR 017 admin-write response envelope
 * primitives extracted from `services/admin.ts`. Every admin
 * mutation (`upsertCashbackConfig`, `retryPayout`,
 * `applyCreditAdjustment`, `applyAdminWithdrawal`, `resyncMerchants`,
 * etc.) returns `{ result, audit }` — pulling these two types out
 * lets each writer surface live in its own slice without a
 * circular import back into admin.ts.
 *
 * `audit.replayed: true` means the backend found a prior snapshot
 * for the supplied `Idempotency-Key` and returned the stored
 * response verbatim — the write is a safe re-fire, not a fresh
 * apply.
 */

/**
 * Common audit payload returned with every admin-write response.
 * The `idempotencyKey` is whatever the client sent on the
 * mutation request; `replayed` is the backend's signal that the
 * mutation was a re-fire of an already-applied request.
 */
export interface AdminWriteAudit {
  actorUserId: string;
  actorEmail: string;
  idempotencyKey: string;
  appliedAt: string;
  replayed: boolean;
}

/**
 * Generic ADR 017 admin-write response envelope. The `result` is
 * the per-endpoint payload (a `MerchantCashbackConfig`, an
 * `AdminPayoutView`, etc.); `audit` is always the `AdminWriteAudit`
 * shape above.
 */
export interface AdminWriteEnvelope<T> {
  result: T;
  audit: AdminWriteAudit;
}
