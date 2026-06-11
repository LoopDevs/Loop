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
import type {
  AddFavoriteResult,
  FavoriteMerchantView,
  ListFavoritesResponse,
  RemoveFavoriteResult,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

// Types now live in @loop/shared (packages/shared/src/user-favorites.ts — ADR 019).
// Re-exported so existing import sites that read them from this module keep resolving.
export type {
  AddFavoriteResult,
  FavoriteMerchantView,
  ListFavoritesResponse,
  RemoveFavoriteResult,
};

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
