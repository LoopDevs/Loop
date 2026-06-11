/**
 * Per-user favourite-merchants wire shapes (ADR 019).
 *
 * Single source of truth for the three `/api/users/me/favorites`
 * endpoints consumed by both `apps/backend/src/users/favorites-handler.ts`
 * and `apps/web/app/services/favorites.ts`. Promoted from duplicated
 * local declarations after the ADR 019 two-consumer threshold was met.
 */
import type { Merchant } from './merchants.js';

export interface FavoriteMerchantView {
  merchantId: string;
  /** ISO-8601 timestamp of when the user added the favourite. */
  createdAt: string;
  /**
   * Catalog row at read-time. Null when the favourited merchant is
   * temporarily evicted from the in-memory catalog (ADR 021). The UI
   * filters these out, but exposing the field lets the client distinguish
   * "favourite is gone forever" from "we don't know yet" if we ever want
   * to surface that.
   */
  merchant: Merchant | null;
}

/** `GET /api/users/me/favorites` response. */
export interface ListFavoritesResponse {
  favorites: FavoriteMerchantView[];
  /**
   * Total favourite rows on the user's account (including evicted-merchant
   * rows). Lets the UI render "X / 50" without a separate count call.
   */
  total: number;
}

/** `POST /api/users/me/favorites` response. */
export interface AddFavoriteResult {
  merchantId: string;
  createdAt: string;
  /** True when this call inserted a new row; false if the favourite already existed. */
  added: boolean;
}

/** `DELETE /api/users/me/favorites/:merchantId` response. */
export interface RemoveFavoriteResult {
  merchantId: string;
  /** True when this call deleted a row; false if there was nothing to remove. */
  removed: boolean;
}
