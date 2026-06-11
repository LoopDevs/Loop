/**
 * Public LOOP-asset wire shapes (ADR 015 / 019 / 020).
 *
 * Single source of truth for the `/api/public/loop-assets` endpoint
 * response consumed by both `apps/backend/src/public/loop-assets.ts`
 * and `apps/web/app/services/public-stats.ts`. Promoted from
 * duplicated local declarations after the ADR 019 two-consumer
 * threshold was met.
 *
 * `code` uses the `LoopAssetCode` union from `loop-asset.ts` rather
 * than a hardcoded `'USDLOOP' | 'GBPLOOP' | 'EURLOOP'` literal so
 * adding a new asset code in one place propagates here automatically.
 */
import type { LoopAssetCode } from './loop-asset.js';

export interface PublicLoopAsset {
  /** Stellar asset code — e.g. `USDLOOP`. */
  code: LoopAssetCode;
  /** Stellar account public key (G...) that mints the asset. */
  issuer: string;
}

/** `GET /api/public/loop-assets` response. */
export interface PublicLoopAssetsResponse {
  assets: PublicLoopAsset[];
}
