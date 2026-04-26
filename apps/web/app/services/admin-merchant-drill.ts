/**
 * A2-1165 (slice 15): admin per-merchant drill surface extracted
 * from `services/admin.ts`. Two reads back the headline cards on
 * the admin merchant-detail page (sibling of the user-drill
 * slice 14):
 *
 * - `GET /api/admin/merchants/:merchantId/flywheel-stats` —
 *   per-merchant recycled-vs-total scalar over the 31-day window.
 *   No `currency` field; per-merchant volume can span multiple
 *   user `home_currencies`, so charges are summed without a
 *   common denomination. The chip renders by count + percentage
 *   only.
 * - `GET /api/admin/merchants/:merchantId/cashback-summary` —
 *   per-currency breakdown of `user_cashback_minor` summed over
 *   the merchant's fulfilled orders. Per-currency (not rolled
 *   up) because the merchant's volume spans user
 *   `home_currencies` with no coherent rolled-up denomination.
 *   Each bucket carries `lifetimeChargeMinor` for the
 *   "cashback as % of spend" denominator.
 *
 * The `AdminMerchantFlywheelStats` /
 * `AdminMerchantCashbackCurrencyBucket` /
 * `AdminMerchantCashbackSummary` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would just
 * add indirection. `services/admin.ts` keeps a barrel re-export
 * so existing consumers (`AdminMerchantFlywheelChip.tsx`,
 * `AdminMerchantCashbackCard.tsx`, the merchant-drill route +
 * paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * Admin per-merchant flywheel scalar. Sibling of the per-user
 * variant, but scoped to a merchant's 31-day fulfilled volume.
 * No `currency` field — per-merchant volume can span multiple
 * user `home_currencies`, so charges are summed without a common
 * denomination. The chip renders by count + percentage only.
 */
export interface AdminMerchantFlywheelStats {
  merchantId: string;
  /** ISO-8601 start of the 31-day window. */
  since: string;
  totalFulfilledCount: number;
  recycledOrderCount: number;
  /** SUM(charge_minor) over loop_asset orders. bigint-as-string. */
  recycledChargeMinor: string;
  /** SUM(charge_minor) over every fulfilled order. bigint-as-string. */
  totalChargeMinor: string;
}

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

/** `GET /api/admin/merchants/:merchantId/flywheel-stats` — per-merchant recycled-vs-total. */
export async function getAdminMerchantFlywheelStats(
  merchantId: string,
): Promise<AdminMerchantFlywheelStats> {
  return authenticatedRequest<AdminMerchantFlywheelStats>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/flywheel-stats`,
  );
}

/** `GET /api/admin/merchants/:merchantId/cashback-summary` — per-currency cashback paid out. */
export async function getAdminMerchantCashbackSummary(
  merchantId: string,
): Promise<AdminMerchantCashbackSummary> {
  return authenticatedRequest<AdminMerchantCashbackSummary>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/cashback-summary`,
  );
}
