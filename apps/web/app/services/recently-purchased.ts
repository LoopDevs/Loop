/**
 * `GET /api/users/me/recently-purchased` client (Tranche 2 user-value).
 *
 * Sister read to `services/favorites.ts` — the home strip pattern uses
 * one for pinned merchants, this one for derived "you bought from
 * here recently" merchants. The list response surfaces evicted-from-
 * catalog entries as `merchant: null`; the UI filters those out so
 * the strip never renders a stale id.
 */
import type { Merchant } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export interface RecentlyPurchasedMerchantView {
  merchantId: string;
  /** ISO-8601 timestamp of the user's most recent qualifying order with this merchant. */
  lastPurchasedAt: string;
  /** Total qualifying orders this user has with this merchant. */
  orderCount: number;
  /**
   * Catalog row at read-time; null when the merchant is temporarily
   * evicted from the in-memory catalog (ADR 021).
   */
  merchant: Merchant | null;
}

export interface RecentlyPurchasedResponse {
  merchants: RecentlyPurchasedMerchantView[];
}

export async function listRecentlyPurchased(
  opts: {
    /** Optional integer in [1, 20]. Defaults to 8 server-side. */
    limit?: number;
  } = {},
): Promise<RecentlyPurchasedResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return authenticatedRequest<RecentlyPurchasedResponse>(
    `/api/users/me/recently-purchased${qs.length > 0 ? `?${qs}` : ''}`,
  );
}
