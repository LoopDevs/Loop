/**
 * A2-1165 (slice 27): admin top-users leaderboard read extracted
 * from `services/admin.ts`. Single read for the cashback-earner
 * ranking on the admin dashboard (ADR 009 / 015):
 *
 * - `GET /api/admin/top-users` — ranked list of users by
 *   cashback earned in the window. Grouped by
 *   `(user, currency)` because summing across home currencies
 *   is meaningless. `amountMinor` is the positive cashback sum
 *   in the window as a bigint-as-string. Default window 30d
 *   (clamped [1, 366]); default limit 20 (clamped [1, 100]).
 *
 * The `TopUserRow` / `TopUsersResponse` shapes were inline in
 * `services/admin.ts` and move with the function. No other
 * consumers, so promoting them to `@loop/shared` would just add
 * indirection. `services/admin.ts` keeps a barrel re-export so
 * existing consumers (`TopUsersCard.tsx` + paired test) don't
 * have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * Top earners ranking. Grouped by `(user, currency)` — summing
 * across currencies is meaningless. `amountMinor` is the positive
 * cashback sum in the window as a bigint-as-string.
 */
export interface TopUserRow {
  userId: string;
  email: string;
  currency: string;
  count: number;
  amountMinor: string;
}

export interface TopUsersResponse {
  since: string;
  rows: TopUserRow[];
}

/** `GET /api/admin/top-users` — default 30d window, default limit 20. */
export async function getTopUsers(
  opts: { since?: string; limit?: number } = {},
): Promise<TopUsersResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<TopUsersResponse>(
    `/api/admin/top-users${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
