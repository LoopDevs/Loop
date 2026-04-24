/**
 * Admin asset-observability response shapes (A2-1506 slice).
 *
 * The ADR 015 stablecoin rails mint LOOP-family assets backed by
 * off-chain user-credit liabilities. Two admin endpoints surface the
 * reserve-vs-liability picture:
 *
 *   - `GET /api/admin/assets/:assetCode/circulation` returns the
 *     per-asset on-chain / off-chain comparison at read time.
 *   - `GET /api/admin/asset-drift/state` returns the background
 *     watcher's last-known drift-state per asset (continuous signal).
 *
 * Types lived in three places:
 *   - backend `admin/asset-circulation.ts` — handler / openapi source
 *   - backend `admin/asset-drift-state.ts` — handler / openapi source
 *   - web `services/admin.ts` — consumer redeclaration
 * Plus the watcher's `DriftState` in `payments/asset-drift-watcher.ts`
 * was a separate spelling of the same literal union.
 *
 * Consolidated here. Re-exported from both sides.
 */
import type { HomeCurrency, LoopAssetCode } from './loop-asset.js';

/**
 * `GET /api/admin/assets/:assetCode/circulation` — per-asset reserve
 * state at a point in time. `driftStroops` is the safety-critical
 * metric: non-zero drift that isn't explained by in-flight payouts
 * means the on-chain supply no longer matches the off-chain liability.
 */
export interface AssetCirculationResponse {
  assetCode: LoopAssetCode;
  fiatCurrency: HomeCurrency;
  issuer: string;
  /** On-chain issued total in stroops (bigint-as-string). */
  onChainStroops: string;
  /** Off-chain ledger liability for the matching fiat, minor units (bigint-as-string). */
  ledgerLiabilityMinor: string;
  /** On-chain minus ledger (in stroops). Positive = over-minted; negative = unsettled. */
  driftStroops: string;
  /** Unix ms the Horizon read was taken. */
  onChainAsOfMs: number;
}

/**
 * Per-asset drift watcher state from the continuous background watcher.
 *
 *   - `unknown` — the watcher has not yet observed this asset
 *     (bootstrap state; present on fresh process start).
 *   - `ok` — drift is within the configured threshold.
 *   - `over` — the last observation exceeded the threshold; ops has
 *     been paged via the `notifyAssetDrift` Discord surface.
 */
export type AssetDriftState = 'unknown' | 'ok' | 'over';

/**
 * One asset's watcher-side snapshot. `null` fields pre-first-tick
 * (before the watcher has run against this asset in this process).
 */
export interface AssetDriftStateRow {
  assetCode: LoopAssetCode;
  state: AssetDriftState;
  /** Last drift in stroops (bigint-as-string). `null` until the asset has been read. */
  lastDriftStroops: string | null;
  /** Threshold used for the last comparison (bigint-as-string). `null` pre-first-tick. */
  lastThresholdStroops: string | null;
  /** Unix ms of the last successful per-asset read. `null` pre-first-tick. */
  lastCheckedMs: number | null;
}

/**
 * `GET /api/admin/asset-drift/state` — watcher snapshot across every
 * configured LOOP asset. Rendered on `/admin/assets` as the
 * "drift watcher" card so ops can see the continuous signal alongside
 * the point-in-time `AssetCirculationResponse`.
 */
export interface AssetDriftStateResponse {
  /** Unix ms the watcher last completed a pass (any result). `null` when inactive. */
  lastTickMs: number | null;
  /** True when the background interval is running in this process. */
  running: boolean;
  perAsset: AssetDriftStateRow[];
}
