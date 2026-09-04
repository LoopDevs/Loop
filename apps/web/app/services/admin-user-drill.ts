/**
 * A2-1165 (slice 14): admin per-user drill surface extracted from
 * `services/admin.ts`. Two reads back the user-detail page on
 * the admin panel (ADR 009 / 015):
 *
 * - `GET /api/admin/users/:userId/credits` — multi-currency
 *   credit balances. One row per (user, currency); shape matches
 *   the off-chain ledger directly so the drill table can render
 *   without further reshaping.
 * - `GET /api/admin/users/:userId/cashback-summary` — scalar
 *   headline (lifetime + this-month) scoped to the user's
 *   current `home_currency`. Admin mirror of
 *   `/api/users/me/cashback-summary`. Drives the compact "£42
 *   lifetime · £3.20 this month" chip.
 *
 * The `AdminUserCreditRow` / `AdminUserCreditsResponse` /
 * `AdminUserCashbackSummary` shapes
 * were inline in `services/admin.ts` and move with the functions.
 * They have no other consumers, so promoting them to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`AdminUserDetail.tsx`, the admin user-drill route + paired
 * tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/** One credit-balance row per (user, currency). */
export interface AdminUserCreditRow {
  currency: string;
  balanceMinor: string;
  updatedAt: string;
}

export interface AdminUserCreditsResponse {
  userId: string;
  rows: AdminUserCreditRow[];
}

/**
 * Admin per-user cashback scalar (ADR 009 / 015). Lifetime + this-month
 * cashback earned, scoped to the user's current `home_currency`.
 */
export interface AdminUserCashbackSummary {
  userId: string;
  currency: string;
  lifetimeMinor: string;
  thisMonthMinor: string;
}

/** `GET /api/admin/users/:userId/credits` — multi-currency balance drill. */
export async function getAdminUserCredits(userId: string): Promise<AdminUserCreditsResponse> {
  return authenticatedRequest<AdminUserCreditsResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/credits`,
  );
}

/** `GET /api/admin/users/:userId/cashback-summary` — scalar headline. */
export async function getAdminUserCashbackSummary(
  userId: string,
): Promise<AdminUserCashbackSummary> {
  return authenticatedRequest<AdminUserCashbackSummary>(
    `/api/admin/users/${encodeURIComponent(userId)}/cashback-summary`,
  );
}
