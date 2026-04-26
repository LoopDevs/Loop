/**
 * A2-1165 (slice 17): admin cashback-monthly + payouts-monthly
 * surface extracted from `services/admin.ts`. Four reads cover
 * the 12-month time-series quartet across the ADR 022 fleet /
 * per-merchant / per-user scopes (ADR 009 / 015 / 016):
 *
 * - `GET /api/admin/cashback-monthly` — fleet-wide cashback
 *   emissions grouped by (month, currency). Drives the monthly
 *   bar chart on `/admin/treasury`.
 * - `GET /api/admin/payouts-monthly` — settlement-side sibling.
 *   Confirmed on-chain payouts grouped by (month, assetCode).
 *   Stroops rather than fiat minor because `pending_payouts`
 *   pins the Stellar-native amount.
 * - `GET /api/admin/users/:userId/cashback-monthly` — per-user
 *   12-month trend. Same `AdminCashbackMonthlyEntry` shape so
 *   `MonthlyCashbackChart` accepts either.
 * - `GET /api/admin/merchants/:merchantId/cashback-monthly` —
 *   per-merchant 12-month trend. `currency` here is the order's
 *   `charge_currency` (the user's home_currency at
 *   order-creation time).
 *
 * The four `…Entry` and four `…Response` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would
 * just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (`MonthlyCashbackChart.tsx`,
 * `PayoutsMonthlyChart.tsx`, the user/merchant drill routes,
 * paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * Fleet-wide cashback-monthly entry. Identical shape to the
 * user-facing `CashbackMonthlyEntry` by design — the admin chart
 * re-uses the same bar-rendering helpers. One entry per
 * (month, currency) pair; oldest-first ordering.
 */
export interface AdminCashbackMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  currency: string;
  /** bigint-as-string, minor units. */
  cashbackMinor: string;
}

export interface AdminCashbackMonthlyResponse {
  entries: AdminCashbackMonthlyEntry[];
}

/**
 * Settlement-side sibling of `AdminCashbackMonthlyEntry`. Confirmed
 * on-chain payouts grouped by (month, assetCode). Stroops rather
 * than fiat minor because `pending_payouts` pins the Stellar-
 * native amount.
 */
export interface AdminPayoutsMonthlyEntry {
  /** "YYYY-MM" in UTC. */
  month: string;
  /** LOOP asset code — USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
  /** SUM(amount_stroops) of confirmed payouts. bigint-as-string. */
  paidStroops: string;
  payoutCount: number;
}

export interface AdminPayoutsMonthlyResponse {
  entries: AdminPayoutsMonthlyEntry[];
}

/**
 * Per-user cashback-monthly response. Same entry shape as the
 * fleet-wide `AdminCashbackMonthlyEntry` — the chart primitive
 * in `MonthlyCashbackChart` accepts either.
 */
export interface AdminUserCashbackMonthlyEntry {
  month: string;
  currency: string;
  cashbackMinor: string;
}

export interface AdminUserCashbackMonthlyResponse {
  userId: string;
  entries: AdminUserCashbackMonthlyEntry[];
}

/**
 * Per-merchant cashback-monthly response. Same entry shape as the
 * per-user and fleet variants; `currency` here is the order's
 * `charge_currency` (the user's home_currency at order-creation
 * time).
 */
export interface AdminMerchantCashbackMonthlyEntry {
  month: string;
  currency: string;
  cashbackMinor: string;
}

export interface AdminMerchantCashbackMonthlyResponse {
  merchantId: string;
  entries: AdminMerchantCashbackMonthlyEntry[];
}

/** `GET /api/admin/cashback-monthly` — 12-month fleet-wide cashback emissions. */
export async function getAdminCashbackMonthly(): Promise<AdminCashbackMonthlyResponse> {
  return authenticatedRequest<AdminCashbackMonthlyResponse>('/api/admin/cashback-monthly');
}

/** `GET /api/admin/payouts-monthly` — 12-month fleet-wide confirmed payouts by (month, assetCode). */
export async function getAdminPayoutsMonthly(): Promise<AdminPayoutsMonthlyResponse> {
  return authenticatedRequest<AdminPayoutsMonthlyResponse>('/api/admin/payouts-monthly');
}

/** `GET /api/admin/users/:userId/cashback-monthly` — 12-month trend for one user. */
export async function getAdminUserCashbackMonthly(
  userId: string,
): Promise<AdminUserCashbackMonthlyResponse> {
  return authenticatedRequest<AdminUserCashbackMonthlyResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/cashback-monthly`,
  );
}

/** `GET /api/admin/merchants/:merchantId/cashback-monthly` — 12-month trend for one merchant. */
export async function getAdminMerchantCashbackMonthly(
  merchantId: string,
): Promise<AdminMerchantCashbackMonthlyResponse> {
  return authenticatedRequest<AdminMerchantCashbackMonthlyResponse>(
    `/api/admin/merchants/${encodeURIComponent(merchantId)}/cashback-monthly`,
  );
}
