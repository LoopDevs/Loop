/**
 * A2-1165 (slice 18): admin per-merchant activity surface
 * extracted from `services/admin.ts`. One read backs the
 * merchant-detail page (companion to the scalar
 * `admin-merchant-drill.ts` from slice 15):
 *
 * - `GET /api/admin/merchants/:merchantId/top-earners` — ranked
 *   top cashback earners at one merchant. One row per
 *   (user, charge_currency) pair — a user can appear twice if
 *   they've fulfilled orders at the merchant in two currencies.
 *
 * The `MerchantTopEarnerRow` / `AdminMerchantTopEarnersResponse`
 * shapes were inline in `services/admin.ts` and move with the
 * functions. They have no other consumers, so promoting them to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`MerchantTopEarnersTable.tsx`, the merchant-drill route +
 * paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

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
