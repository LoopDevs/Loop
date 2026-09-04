/**
 * A2-1165 (slice 19): admin fleet-level user-activity surface
 * extracted from `services/admin.ts`. One leaderboard read
 * complements the per-user drill from slice 14:
 *
 * - `GET /api/admin/users/top-by-pending-payout` — ranked users
 *   with the most in-flight (pending + submitted) on-chain
 *   payout debt, grouped by (user, asset). Drives ops funding
 *   prioritisation on the treasury page: "who's owed the most
 *   USDLOOP right now?" is the first question before topping up
 *   an operator reserve. (The recycling-activity sibling retired
 *   with ADR 052 — the loop_asset payment rail is gone.)
 *
 * The `TopUserByPendingPayoutEntry` /
 * `TopUsersByPendingPayoutResponse` shapes were inline in
 * `services/admin.ts` and move with the functions. They have no
 * other consumers, so promoting them to `@loop/shared` would just
 * add indirection. `services/admin.ts` keeps a barrel re-export so
 * existing consumers (`TopUsersByPendingPayoutCard.tsx`, the
 * treasury route + paired tests) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/** One entry in the top-users-by-pending-payout leaderboard. */
export interface TopUserByPendingPayoutEntry {
  userId: string;
  email: string;
  /** LOOP asset code (USDLOOP / GBPLOOP / EURLOOP). */
  assetCode: string;
  /** Summed in-flight payout amount, stroops as bigint-string. */
  totalStroops: string;
  /** Number of payout rows contributing to totalStroops. */
  payoutCount: number;
}

export interface TopUsersByPendingPayoutResponse {
  entries: TopUserByPendingPayoutEntry[];
}

/** `GET /api/admin/users/top-by-pending-payout?limit=` — top in-flight payout debt by (user, asset). */
export async function getTopUsersByPendingPayout(
  opts: { limit?: number } = {},
): Promise<TopUsersByPendingPayoutResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<TopUsersByPendingPayoutResponse>(
    `/api/admin/users/top-by-pending-payout${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
