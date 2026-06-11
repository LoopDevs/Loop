/**
 * `GET /api/users/me/recently-purchased` client (Tranche 2 user-value).
 *
 * Sister read to `services/favorites.ts` — the home strip pattern uses
 * one for pinned merchants, this one for derived "you bought from
 * here recently" merchants. The list response surfaces evicted-from-
 * catalog entries as `merchant: null`; the UI filters those out so
 * the strip never renders a stale id.
 */
import type { RecentlyPurchasedMerchantView, RecentlyPurchasedResponse } from '@loop/shared';
import { authenticatedRequest } from './api-client';

// Types now live in @loop/shared
// (packages/shared/src/user-recently-purchased.ts — ADR 019).
// Re-exported so existing import sites that read them from this module keep resolving.
export type { RecentlyPurchasedMerchantView, RecentlyPurchasedResponse };

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
