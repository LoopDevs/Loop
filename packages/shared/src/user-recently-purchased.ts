/**
 * Per-user recently-purchased-merchants wire shapes (ADR 019).
 *
 * Single source of truth for the `/api/users/me/recently-purchased`
 * endpoint consumed by both
 * `apps/backend/src/users/recently-purchased-handler.ts` and
 * `apps/web/app/services/recently-purchased.ts`. Promoted from
 * duplicated local declarations after the ADR 019 two-consumer
 * threshold was met.
 */
import type { Merchant } from './merchants.js';

export interface RecentlyPurchasedMerchantView {
  merchantId: string;
  /**
   * ISO-8601, the user's most recent qualifying order with this
   * merchant. Drives client-side ordering when it needs to merge
   * with another stream.
   */
  lastPurchasedAt: string;
  /** Total qualifying orders this user has with this merchant. */
  orderCount: number;
  /**
   * Catalog row at read-time. Null when the merchant is temporarily
   * evicted from the in-memory catalog (ADR 021); the strip filters
   * those out so a stale id never crashes the render path.
   */
  merchant: Merchant | null;
}

/** `GET /api/users/me/recently-purchased` response. */
export interface RecentlyPurchasedResponse {
  merchants: RecentlyPurchasedMerchantView[];
}
