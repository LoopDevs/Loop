/**
 * Public marketing-surface fetches. No auth; aggressively cached by
 * the backend's Cache-Control so TanStack's default 30s staleTime is
 * a safe ceiling.
 */
import { apiRequest } from './api-client';

/** Shape mirrors `apps/backend/src/public/stats.ts PublicStats`. */
export interface PublicStats {
  paidCashbackMinor: Record<string, string>;
  paidUserCount: string;
  merchantsWithOrders: string;
  fulfilledOrderCount: string;
}

/** `GET /api/public/stats` — lifetime marketing aggregates. */
export async function getPublicStats(): Promise<PublicStats> {
  return apiRequest<PublicStats>('/api/public/stats');
}
