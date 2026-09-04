/**
 * A2-1165 (slice 15): admin per-merchant drill surface extracted
 * from `services/admin.ts`. One read backs the headline cards on
 * the admin merchant-detail page (sibling of the user-drill
 * slice 14):
 *
 * - `GET /api/admin/merchants/:merchantId/cashback-summary` —
 *   per-currency breakdown of `user_cashback_minor` summed over
 *   the merchant's fulfilled orders. Per-currency (not rolled
 *   up) because the merchant's volume spans user
 *   `home_currencies` with no coherent rolled-up denomination.
 *   Each bucket carries `lifetimeChargeMinor` for the
 *   "cashback as % of spend" denominator.
 *
 * The `AdminMerchantCashbackCurrencyBucket` /
 * `AdminMerchantCashbackSummary` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would just
 * add indirection. `services/admin.ts` keeps a barrel re-export
 * so existing consumers (`AdminMerchantCashbackCard.tsx`, the
 * merchant-drill route + paired tests) don't have to re-target
 * imports.
 */
import { authenticatedRequest } from './api-client';

/** Per-currency bucket within `AdminMerchantCashbackSummary`. */
export interface AdminMerchantCashbackCurrencyBucket {
  currency: string;
  fulfilledCount: number;
  /** SUM(user_cashback_minor) over fulfilled orders in this currency. bigint-as-string. */
  lifetimeCashbackMinor: string;
  /** SUM(charge_minor) in this currency — "cashback as % of spend" denominator. */
  lifetimeChargeMinor: string;
}

export interface AdminMerchantCashbackSummary {
  merchantId: string;
  totalFulfilledCount: number;
  /** Sorted desc by fulfilledCount. Empty for zero-volume merchants (not 404). */
  currencies: AdminMerchantCashbackCurrencyBucket[];
}

/** `GET /api/admin/merchants/:merchantId/cashback-summary` — per-currency cashback paid out. */
export async function getAdminMerchantCashbackSummary(
  merchantId: string,
): Promise<AdminMerchantCashbackSummary> {
  return authenticatedRequest<AdminMerchantCashbackSummary>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/cashback-summary`,
  );
}
