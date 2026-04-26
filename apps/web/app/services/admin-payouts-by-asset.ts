/**
 * A2-1165 (slice 26): admin payouts-by-asset incident-triage
 * surface extracted from `services/admin.ts`. Companion to slice
 * 25's `admin-payouts.ts` — that one is the per-row drilldown,
 * this one is the cross-asset state-bucket pivot:
 *
 * - `GET /api/admin/payouts-by-asset` (ADR 015 / 016) —
 *   crossed incident-triage view of `pending_payouts` keyed by
 *   `(asset_code, state)`. Answers "which LOOP assets are
 *   affected when I see N failed payouts?" at a glance.
 *
 * The `PerStateBreakdown` / `PayoutsByAssetRow` shapes were
 * inline in `services/admin.ts` and move with the function. They
 * have no other consumers, so promoting them to `@loop/shared`
 * would just add indirection. `services/admin.ts` keeps a barrel
 * re-export so existing consumers (`PayoutsByAssetCard.tsx`,
 * paired test) don't have to re-target imports.
 */
import { authenticatedRequest } from './api-client';

/**
 * Per-state counts + stroop sums for a single `asset_code` bucket
 * in `pending_payouts`. Zero-counts are surfaced so the admin UI
 * can show an explicit "0 failed" rather than a missing row.
 */
export interface PerStateBreakdown {
  count: number;
  stroops: string;
}

export interface PayoutsByAssetRow {
  assetCode: string;
  pending: PerStateBreakdown;
  submitted: PerStateBreakdown;
  confirmed: PerStateBreakdown;
  failed: PerStateBreakdown;
}

/** `GET /api/admin/payouts-by-asset` — crossed (asset_code, state) incident-triage view. */
export async function getPayoutsByAsset(): Promise<{ rows: PayoutsByAssetRow[] }> {
  return authenticatedRequest<{ rows: PayoutsByAssetRow[] }>('/api/admin/payouts-by-asset');
}
