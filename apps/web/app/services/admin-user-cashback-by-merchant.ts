/**
 * A2-1165 (slice 21): admin per-user cashback-by-merchant
 * surface extracted from `services/admin.ts`. One read backs the
 * support-triage drill table on the admin user-detail page (ADR
 * 009 / 015):
 *
 * - `GET /api/admin/users/:userId/cashback-by-merchant` —
 *   per-merchant breakdown of the target user's cashback
 *   earnings over the window. Admin-facing equivalent of the
 *   user's own card; same join on
 *   `credit_transactions.reference_id::uuid = orders.id`, same
 *   ordering, but with the caller resolved from the URL userId
 *   rather than the session. Default window 180d (cap 366d);
 *   default limit 25 (cap 100).
 *
 * The `AdminUserCashbackByMerchantRow` /
 * `AdminUserCashbackByMerchantResponse` shapes were inline in
 * `services/admin.ts` and move with the function. They have no
 * other consumers, so promoting them to `@loop/shared` would
 * just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (`UserCashbackByMerchantCard
 * .tsx`, paired test) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/** One row of an admin per-user cashback-by-merchant breakdown. */
export interface AdminUserCashbackByMerchantRow {
  merchantId: string;
  cashbackMinor: string;
  orderCount: number;
  lastEarnedAt: string;
}

export interface AdminUserCashbackByMerchantResponse {
  userId: string;
  currency: string;
  since: string;
  rows: AdminUserCashbackByMerchantRow[];
}

/** `GET /api/admin/users/:userId/cashback-by-merchant` — default 180d window, default limit 25. */
export async function getAdminUserCashbackByMerchant(
  userId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<AdminUserCashbackByMerchantResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<AdminUserCashbackByMerchantResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/cashback-by-merchant${
      qs.length > 0 ? `?${qs}` : ''
    }`,
  );
}
