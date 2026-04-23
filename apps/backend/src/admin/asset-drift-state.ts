/**
 * Admin asset-drift state (ADR 015).
 *
 * `GET /api/admin/asset-drift/state` — surfaces the in-memory state
 * of the background drift watcher (see
 * `apps/backend/src/payments/asset-drift-watcher.ts`). Lets the
 * admin UI render "which LOOP assets are currently over threshold"
 * without each browser-load re-polling Horizon.
 *
 * The watcher fires every 300s by default, reads Horizon for each
 * configured LOOP asset, and caches the drift value + over/ok
 * classification in-memory. This endpoint is a cheap dump of that
 * cache. Process-local, reset on restart — if the operator wants a
 * fresh number they can hit the existing per-asset circulation
 * endpoint which forces a Horizon read.
 *
 * Returns 200 with a `perAsset: []` when the watcher hasn't been
 * started (no LOOP issuers configured). Clients render "watcher
 * inactive" from `running: false` rather than showing a zero-state
 * that implies healthy drift.
 */
import type { Context } from 'hono';
import type { LoopAssetCode } from '@loop/shared';
import { getAssetDriftState, type DriftState } from '../payments/asset-drift-watcher.js';

export interface AssetDriftStateRow {
  assetCode: LoopAssetCode;
  state: DriftState;
  /** Last drift in stroops (bigint-as-string). `null` until the asset has been read. */
  lastDriftStroops: string | null;
  /** Threshold used for the last comparison (bigint-as-string). `null` pre-first-tick. */
  lastThresholdStroops: string | null;
  /** Unix ms of the last successful per-asset read. `null` pre-first-tick. */
  lastCheckedMs: number | null;
}

export interface AssetDriftStateResponse {
  /** Unix ms the watcher last completed a pass (any result). `null` when inactive. */
  lastTickMs: number | null;
  /** True when the background interval is running in this process. */
  running: boolean;
  perAsset: AssetDriftStateRow[];
}

export function adminAssetDriftStateHandler(c: Context): Response {
  const state = getAssetDriftState();
  const body: AssetDriftStateResponse = {
    lastTickMs: state.lastTickMs,
    running: state.running,
    perAsset: state.perAsset.map((a) => ({
      assetCode: a.assetCode,
      state: a.state,
      lastDriftStroops: a.lastDriftStroops === null ? null : a.lastDriftStroops.toString(),
      lastThresholdStroops:
        a.lastThresholdStroops === null ? null : a.lastThresholdStroops.toString(),
      lastCheckedMs: a.lastCheckedMs,
    })),
  };
  return c.json(body);
}
