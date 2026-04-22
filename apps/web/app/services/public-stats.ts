import type { PerCurrencyCashback, PublicCashbackStats } from '@loop/shared';
import { apiRequest } from './api-client';

// Response shapes live in `@loop/shared` — one source of truth with
// the backend handler + openapi.ts schema (ADR 019 / 020). Re-exported
// so existing `import { PublicCashbackStats } from '~/services/public-stats'`
// callers keep resolving without every consumer learning the shared path.
export type { PerCurrencyCashback, PublicCashbackStats };

/**
 * `GET /api/public/cashback-stats` (ADR 020 Tier-1) — unauthenticated
 * marketing-facing aggregate. Never-500: backend serves a cached or
 * zero-valued snapshot when the DB is stale / unavailable.
 */
export async function getPublicCashbackStats(): Promise<PublicCashbackStats> {
  return apiRequest<PublicCashbackStats>('/api/public/cashback-stats');
}
