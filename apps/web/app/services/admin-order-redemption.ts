/**
 * Admin order-redemption surface (ADR 037 §3 — order delivery panel):
 *
 * - `POST /api/admin/orders/:orderId/refetch-redemption` — re-runs
 *   the CTX redemption fetch for a fulfilled order whose redeem
 *   URL/code/PIN came back null. Support-allowed delivery-unsticking
 *   action; idempotency key per the uniform ADR 017 audit discipline.
 *
 * Wire shape lives in `@loop/shared/admin-order-redemption.ts`.
 */
import type { AdminRefetchRedemptionResult } from '@loop/shared';
import { generateIdempotencyKey } from './admin-write-envelope';
import { authenticatedRequest } from './api-client';

/** `POST /api/admin/orders/:orderId/refetch-redemption` */
export async function refetchOrderRedemption(
  orderId: string,
): Promise<AdminRefetchRedemptionResult> {
  return authenticatedRequest<AdminRefetchRedemptionResult>(
    `/api/admin/orders/${encodeURIComponent(orderId)}/refetch-redemption`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': generateIdempotencyKey() },
    },
  );
}
