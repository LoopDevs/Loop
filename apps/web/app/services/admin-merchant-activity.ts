/**
 * A2-1165 (slice 18): admin per-merchant activity surface
 * extracted from `services/admin.ts`. Two reads back the activity
 * charts on the merchant-detail page (companion to the scalar
 * `admin-merchant-drill.ts` from slice 15):
 *
 * - `GET /api/admin/merchants/:merchantId/flywheel-activity` —
 *   daily flywheel time-series. Time-axis companion to the
 *   scalar `AdminMerchantFlywheelStats`: same merchant, same
 *   31-day window (or `?days=`), but one row per day so the UI
 *   can render a trajectory.
 * - `GET /api/admin/merchants/:merchantId/top-earners` — ranked
 *   top cashback earners at one merchant. One row per
 *   (user, charge_currency) pair — a user can appear twice if
 *   they've fulfilled orders at the merchant in two currencies.
 *
 * The `MerchantFlywheelActivityDay` /
 * `AdminMerchantFlywheelActivityResponse` /
 * `MerchantTopEarnerRow` / `AdminMerchantTopEarnersResponse`
 * shapes were inline in `services/admin.ts` and move with the
 * functions. They have no other consumers, so promoting them to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`MerchantFlywheelActivityChart.tsx`,
 * `MerchantTopEarnersTable.tsx`, the merchant-drill route +
 * paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * One day of merchant flywheel activity. Time-axis companion to
 * the scalar `AdminMerchantFlywheelStats` — same merchant, same
 * 31-day window (or whatever `?days` asked for), but one row per
 * day so the UI can render a trajectory.
 */
export interface MerchantFlywheelActivityDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  recycledCount: number;
  totalCount: number;
  /** bigint-as-string. */
  recycledChargeMinor: string;
  /** bigint-as-string. */
  totalChargeMinor: string;
}

export interface AdminMerchantFlywheelActivityResponse {
  merchantId: string;
  days: number;
  rows: MerchantFlywheelActivityDay[];
}

/**
 * Per-merchant top-earners row. One entry per
 * (user, charge_currency) pair — a user can appear twice if
 * they've fulfilled orders at the merchant in two currencies.
 */
export interface MerchantTopEarnerRow {
  userId: string;
  email: string;
  currency: string;
  orderCount: number;
  /** SUM(user_cashback_minor) for this (user, currency). bigint-as-string. */
  cashbackMinor: string;
  /** SUM(charge_minor) — context for "cashback as % of their spend". */
  chargeMinor: string;
}

export interface AdminMerchantTopEarnersResponse {
  merchantId: string;
  since: string;
  rows: MerchantTopEarnerRow[];
}

/** `GET /api/admin/merchants/:merchantId/flywheel-activity` — daily flywheel timeseries. */
export async function getAdminMerchantFlywheelActivity(
  merchantId: string,
  days?: number,
): Promise<AdminMerchantFlywheelActivityResponse> {
  const qs = days !== undefined ? `?days=${days}` : '';
  return authenticatedRequest<AdminMerchantFlywheelActivityResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/flywheel-activity${qs}`,
  );
}

/** `GET /api/admin/merchants/:merchantId/top-earners` — ranked top cashback earners at one merchant. */
export async function getAdminMerchantTopEarners(
  merchantId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<AdminMerchantTopEarnersResponse> {
  const params = new URLSearchParams();
  if (opts.days !== undefined) params.set('days', String(opts.days));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminMerchantTopEarnersResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/top-earners${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
