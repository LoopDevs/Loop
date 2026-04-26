/**
 * A2-1165 (slice 3): admin asset-circulation + asset-drift surface
 * extracted from `services/admin.ts`. The asset domain (ADR 015)
 * tracks per-LOOP-asset on-chain circulation vs the off-chain
 * ledger liability — non-zero drift that isn't explained by
 * in-flight payouts is a safety-critical signal.
 *
 * Type definitions live canonically in `@loop/shared/admin-assets.ts`
 * (per A2-1506); this file re-exports them alongside the two read
 * endpoints. `services/admin.ts` keeps the barrel so existing
 * consumers (`AssetCirculationCard.tsx`, `AssetDriftBadge.tsx`,
 * `AssetDriftWatcherCard.tsx`, `routes/admin.assets.tsx` + paired
 * tests) don't have to re-target imports in the same PR.
 */
import type {
  AssetCirculationResponse,
  AssetDriftState,
  AssetDriftStateResponse,
  AssetDriftStateRow,
} from '@loop/shared';
import { authenticatedRequest } from './api-client';

export type {
  AssetCirculationResponse,
  AssetDriftState,
  AssetDriftStateRow,
  AssetDriftStateResponse,
};

/** `GET /api/admin/assets/:assetCode/circulation` */
export async function getAssetCirculation(assetCode: string): Promise<AssetCirculationResponse> {
  return authenticatedRequest<AssetCirculationResponse>(
    `/api/admin/assets/${encodeURIComponent(assetCode)}/circulation`,
  );
}

/** `GET /api/admin/asset-drift/state` */
export async function getAssetDriftState(): Promise<AssetDriftStateResponse> {
  return authenticatedRequest<AssetDriftStateResponse>('/api/admin/asset-drift/state');
}
