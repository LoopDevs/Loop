/**
 * Per-user favourite-merchants client (Tranche 2 user-value follow-on).
 *
 * Three small calls behind `/api/users/me/favorites`:
 *   - `GET    /api/users/me/favorites`             — list, newest first
 *   - `POST   /api/users/me/favorites`             — add (idempotent)
 *   - `DELETE /api/users/me/favorites/:merchantId` — remove
 *
 * The list response joins the in-memory backend catalog at read-time.
 * Favourites pinned for catalog-evicted merchants (ADR 021) come back
 * with `merchant: null` — the UI filters those out so a stale id never
 * crashes the render path; the underlying favourite row stays so the
 * pin reappears once the merchant returns.
 */
import type { Merchant } from '@loop/shared';
import { authenticatedRequest } from './api-client';

export interface FavoriteMerchantView {
  merchantId: string;
  /** ISO-8601 timestamp of when the user added the favourite. */
  createdAt: string;
  /**
   * Catalog row at read-time; null when the merchant is temporarily
   * evicted from the in-memory catalog (ADR 021).
   */
  merchant: Merchant | null;
}

export interface ListFavoritesResponse {
  favorites: FavoriteMerchantView[];
  total: number;
}

export interface AddFavoriteResult {
  merchantId: string;
  createdAt: string;
  /** True when the call inserted a new row; false when the favourite already existed. */
  added: boolean;
}

export interface RemoveFavoriteResult {
  merchantId: string;
  /** True when the call deleted a row; false when there was nothing to remove. */
  removed: boolean;
}

export async function listFavorites(): Promise<ListFavoritesResponse> {
  return authenticatedRequest<ListFavoritesResponse>('/api/users/me/favorites');
}

export async function addFavorite(merchantId: string): Promise<AddFavoriteResult> {
  return authenticatedRequest<AddFavoriteResult>('/api/users/me/favorites', {
    method: 'POST',
    body: { merchantId },
  });
}

export async function removeFavorite(merchantId: string): Promise<RemoveFavoriteResult> {
  return authenticatedRequest<RemoveFavoriteResult>(
    `/api/users/me/favorites/${encodeURIComponent(merchantId)}`,
    { method: 'DELETE' },
  );
}
