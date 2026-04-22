import { apiRequest } from './api-client';

/**
 * Per-currency cashback total from the public stats endpoint (ADR
 * 009/015/020). `amountMinor` is a bigint-as-string so it round-trips
 * precisely across JSON even for large aggregate sums.
 */
export interface PerCurrencyCashback {
  currency: string;
  amountMinor: string;
}

/**
 * `GET /api/public/cashback-stats` (ADR 020 Tier-1) — unauthenticated
 * marketing-facing aggregate. Never-500: backend serves a cached or
 * zero-valued snapshot when the DB is stale / unavailable.
 */
export interface PublicCashbackStats {
  totalUsersWithCashback: number;
  totalCashbackByCurrency: PerCurrencyCashback[];
  fulfilledOrders: number;
  asOf: string;
}

export async function getPublicCashbackStats(): Promise<PublicCashbackStats> {
  return apiRequest<PublicCashbackStats>('/api/public/cashback-stats');
}
