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

/**
 * Generates a per-click idempotency key for ADR-017 admin writes.
 *
 * Used by every admin writer (`upsertCashbackConfig`,
 * `applyCreditAdjustment`, `applyAdminWithdrawal`, `retryPayout`,
 * `resyncMerchants`) so a double-click on a write button can't
 * apply the mutation twice — the backend looks for a prior snapshot
 * keyed by `Idempotency-Key` and returns the stored response
 * verbatim if one exists (`audit.replayed: true`).
 *
 * Prefers `crypto.randomUUID()` (universally available in supported
 * browsers + the Capacitor webview), with a time + Math.random
 * fallback for non-browser test environments where `crypto` may be
 * absent. UUID hyphens are stripped because the backend treats the
 * key as an opaque token and the shorter form keeps logs tidy.
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
