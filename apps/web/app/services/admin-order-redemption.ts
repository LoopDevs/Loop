/**
 * Admin order-redemption surface (ADR 037 §3 — order delivery panel):
 *
 * - `POST /api/admin/orders/:orderId/refetch-redemption` — re-runs
 *   the CTX redemption fetch for a fulfilled order whose redeem
 *   URL/code/PIN came back null. Support-allowed delivery-unsticking
 *   action; full ADR 017 contract (idempotency key + 2..500 char
 *   reason in the body, `{ result, audit }` envelope back). The
 *   result reports field PRESENCE only — codes are never echoed.
 *
 * Not-applicable states come back as errors, not result flags:
 * 409 `REDEMPTION_NOT_REFETCHABLE` (not fulfilled / no CTX id /
 * already present), 503 `SERVICE_UNAVAILABLE` (operator pool down).
 *
 * Wire shape lives in `@loop/shared/admin-support-ops.ts`.
 */
import type { AdminRefetchRedemptionResult } from '@loop/shared';
import { generateIdempotencyKey, type AdminWriteEnvelope } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `POST /api/admin/orders/:orderId/refetch-redemption` */
export async function refetchOrderRedemption(args: {
  orderId: string;
  reason: string;
}): Promise<AdminWriteEnvelope<AdminRefetchRedemptionResult>> {
  return authenticatedRequest<AdminWriteEnvelope<AdminRefetchRedemptionResult>>(
    `/api/admin/orders/${encodeURIComponent(args.orderId)}/refetch-redemption`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
      body: { reason: args.reason },
    },
  );
}
