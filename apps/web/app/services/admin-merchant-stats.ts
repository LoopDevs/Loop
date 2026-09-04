/**
 * A2-1165 (slice 10): admin merchant-stats surface extracted from
 * `services/admin.ts`. One read covers the fleet view of merchants
 * (ADR 011 / ADR 052):
 *
 * - `GET /api/admin/merchant-stats` — per-merchant aggregate of
 *   fulfilled orders in the window, ranked by `userCashbackMinor`
 *   desc. `currency` is the charge currency for that row's volume;
 *   `uniqueUserCount` is distinct earners. Default window 31d,
 *   clamped [1, 366].
 *
 * The `MerchantStatsRow` / `MerchantStatsResponse` shapes were
 * inline in `services/admin.ts` and move with the functions. They
 * have no other consumers, so promoting them to `@loop/shared`
 * would just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (`MerchantStatsCard.tsx`,
 * `routes/admin.merchants.tsx`, paired tests) don't have to
 * re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * Per-merchant aggregate stats (ADR 011 / 015). Each row sums
 * fulfilled orders for a single merchant in the window; `currency`
 * is the dominant catalog currency for that merchant's volume.
 */
export interface MerchantStatsRow {
  merchantId: string;
  orderCount: number;
  /** Distinct users who earned from this merchant in the window. */
  uniqueUserCount: number;
  faceValueMinor: string;
  /** Commission Loop expects CTX to accrue on this volume (ADR 052). */
  expectedCommissionMinor: string;
  userCashbackMinor: string;
  lastFulfilledAt: string;
  /** Charge currency (the user's home currency) for this row's sums. */
  currency: string;
}

export interface MerchantStatsResponse {
  since: string;
  rows: MerchantStatsRow[];
}

/** `GET /api/admin/merchant-stats` — default window 31d, clamped [1, 366]. */
export async function getMerchantStats(
  opts: { since?: string } = {},
): Promise<MerchantStatsResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  const qs = params.toString();
  return authenticatedRequest<MerchantStatsResponse>(
    `/api/admin/merchant-stats${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
