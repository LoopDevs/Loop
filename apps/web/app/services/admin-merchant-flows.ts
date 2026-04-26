/**
 * A2-1165 (slice 26): admin merchant-flows surface extracted
 * from `services/admin.ts`. The lifetime cashback-flow table
 * rendered on `/admin/cashback` (ADR 011 / 015):
 *
 * - `GET /api/admin/merchant-flows` — one bucket per
 *   (merchantId, chargeCurrency) of fulfilled-order flow.
 *   Rendered below each merchant row so ops can compare
 *   configured split to actual lifetime money movement.
 *
 * The `MerchantFlow` shape was inline in `services/admin.ts`
 * and moves with the function. No other consumers, so promoting
 * it to `@loop/shared` would just add indirection.
 * `services/admin.ts` keeps a barrel re-export so
 * `routes/admin.cashback.tsx` and paired tests don't have to
 * re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * One bucket of fulfilled-order flow, grouped by (merchantId,
 * chargeCurrency). Rendered on /admin/cashback below each row so
 * ops can compare configured split to actual lifetime money
 * movement.
 */
export interface MerchantFlow {
  merchantId: string;
  currency: string;
  count: string;
  faceValueMinor: string;
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
}

/** `GET /api/admin/merchant-flows` — per-merchant fulfilled-order flows. */
export async function listMerchantFlows(): Promise<{ flows: MerchantFlow[] }> {
  return authenticatedRequest<{ flows: MerchantFlow[] }>(`/api/admin/merchant-flows`);
}
