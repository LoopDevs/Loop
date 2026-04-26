/**
 * A2-1165 (slice 26): admin merchants-resync writer extracted
 * from `services/admin.ts`. Fourth and final ADR-017 writer
 * slice after #1125 (cashback-config), #1127 (user-credits),
 * #1130 (payouts):
 *
 * - `POST /api/admin/merchants/resync` (ADR 011 / 017) — force
 *   an immediate CTX catalog sweep. Bypasses the 6h scheduled
 *   refresh so a merchant change lands within seconds. A2-509
 *   made the endpoint ADR-017 compliant: caller supplies a
 *   reason, the service generates a per-click `Idempotency-Key`,
 *   the backend returns the standard `{ result, audit }`
 *   envelope. Two admins clicking simultaneously coalesce into
 *   one upstream sweep via the backend mutex (one response
 *   carries `triggered: true`, the other `triggered: false` with
 *   the same post-sync `loadedAt`). 502 on upstream failure;
 *   cached snapshot is retained.
 *
 * The `AdminMerchantResyncResponse` shape was inline in
 * `services/admin.ts` and moves with the writer. No other
 * consumers, so promoting it to `@loop/shared` would just add
 * indirection. `services/admin.ts` keeps a barrel re-export so
 * `MerchantResyncButton.tsx` and paired tests don't have to
 * re-target imports.
 */
import type { AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** Response shape from `POST /api/admin/merchants/resync`. */
export interface AdminMerchantResyncResponse {
  /** Merchant count after the sweep (not delta vs. pre-sync). */
  merchantCount: number;
  /** ISO-8601 of the currently-loaded snapshot. */
  loadedAt: string;
  /** Whether THIS call advanced the store (vs. coalesced with an in-flight sweep). */
  triggered: boolean;
}

/** Generates a per-click idempotency key for ADR-017 admin writes. */
function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * `POST /api/admin/merchants/resync` — ADR-017 admin write that forces
 * an immediate CTX catalog sweep. Service-generated `Idempotency-Key`
 * makes a double-click coalesce into a single upstream sweep.
 */
export async function resyncMerchants(args: {
  reason: string;
}): Promise<AdminWriteEnvelope<AdminMerchantResyncResponse>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminMerchantResyncResponse>>(
    '/api/admin/merchants/resync',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
    },
  );
}
