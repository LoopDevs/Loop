/**
 * A2-1165 (slice 19): admin fleet-level user-activity surface
 * extracted from `services/admin.ts`. Two leaderboard reads
 * complement the per-user drill from slice 14 and the per-user
 * payment-method-share from slice 13:
 *
 * - `GET /api/admin/users/top-by-pending-payout` — ranked users
 *   with the most in-flight (pending + submitted) on-chain
 *   payout debt, grouped by (user, asset). Drives ops funding
 *   prioritisation on the treasury page: "who's owed the most
 *   USDLOOP right now?" is the first question before topping up
 *   an operator reserve.
 * - `GET /api/admin/users/recycling-activity` — 90-day list of
 *   users with at least one `loop_asset` order, sorted by most-
 *   recent recycle. Zero-recycle users are omitted server-side
 *   (this is explicitly a "who's recycling" list, not a zero-
 *   inflated fleet enumeration). Complements `/top-users` (by
 *   cashback earned) and the new pending-payout list (by
 *   backlog).
 *
 * The `TopUserByPendingPayoutEntry` /
 * `TopUsersByPendingPayoutResponse` /
 * `UserRecyclingActivityRow` / `UsersRecyclingActivityResponse`
 * shapes were inline in `services/admin.ts` and move with the
 * functions. They have no other consumers, so promoting them to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`TopUsersByPendingPayoutCard.tsx`,
 * `UsersRecyclingActivityCard.tsx`, the treasury route + paired
 * tests) don't have to re-target imports.
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

/**
 * One row of the 90-day users-recycling-activity leaderboard.
 * Ranked by most-recent `loop_asset` order; zero-recycle users
 * are omitted server-side. `recycledChargeMinor` is bigint-as-
 * string (fleet-wide precision can push past 2^53).
 */
export interface UserRecyclingActivityRow {
  userId: string;
  email: string;
  lastRecycledAt: string;
  recycledOrderCount: number;
  recycledChargeMinor: string;
  currency: string;
}

export interface UsersRecyclingActivityResponse {
  since: string;
  rows: UserRecyclingActivityRow[];
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

/** `GET /api/admin/users/recycling-activity?limit=` — 90-day loop_asset users sorted by most-recent recycle. */
export async function getAdminUsersRecyclingActivity(
  opts: { limit?: number } = {},
): Promise<UsersRecyclingActivityResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<UsersRecyclingActivityResponse>(
    `/api/admin/users/recycling-activity${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
