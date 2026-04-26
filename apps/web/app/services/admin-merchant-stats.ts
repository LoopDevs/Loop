/**
 * A2-1165 (slice 10): admin merchant-stats + merchants-flywheel-
 * share surface extracted from `services/admin.ts`. Two reads
 * cover the fleet view of merchants on the cashback flywheel
 * (ADR 011 / 015):
 *
 * - `GET /api/admin/merchant-stats` — per-merchant aggregate of
 *   fulfilled orders in the window, ranked by `loopMarginMinor`
 *   desc. `currency` is the dominant catalog currency for that
 *   merchant's volume; `uniqueUserCount` is distinct earners.
 *   Default window 31d, clamped [1, 366].
 * - `GET /api/admin/merchants/flywheel-share` — merchant-axis
 *   flywheel leaderboard ranked by recycled-order-count desc.
 *   Merchants with zero recycled orders are omitted server-side
 *   (explicitly a "who's recycling" list, not zero-inflated).
 *   Default window 31d (cap 366), default limit 25 (cap 100).
 *
 * The `MerchantStatsRow` / `MerchantStatsResponse` /
 * `MerchantFlywheelShareRow` / `MerchantsFlywheelShareResponse`
 * shapes were inline in `services/admin.ts` and move with the
 * functions. They have no other consumers, so promoting them to
 * `@loop/shared` would just add indirection. `services/admin.ts`
 * keeps a barrel re-export so existing consumers
 * (`MerchantStatsCard.tsx`, `MerchantsFlywheelShareCard.tsx`,
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
  wholesaleMinor: string;
  userCashbackMinor: string;
  loopMarginMinor: string;
  lastFulfilledAt: string;
  currency: string;
}

export interface MerchantStatsResponse {
  since: string;
  rows: MerchantStatsRow[];
}

/**
 * One row of the per-merchant flywheel leaderboard. Ranks merchants
 * by how many of their fulfilled orders came through the LOOP-asset
 * rail (recycled cashback). Merchants with zero recycled orders are
 * omitted server-side.
 */
export interface MerchantFlywheelShareRow {
  merchantId: string;
  totalFulfilledCount: number;
  recycledOrderCount: number;
  recycledChargeMinor: string;
  totalChargeMinor: string;
}

export interface MerchantsFlywheelShareResponse {
  since: string;
  rows: MerchantFlywheelShareRow[];
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

/** `GET /api/admin/merchants/flywheel-share` — default 31d window, default limit 25. */
export async function getAdminMerchantsFlywheelShare(
  opts: { since?: string; limit?: number } = {},
): Promise<MerchantsFlywheelShareResponse> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<MerchantsFlywheelShareResponse>(
    `/api/admin/merchants/flywheel-share${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
