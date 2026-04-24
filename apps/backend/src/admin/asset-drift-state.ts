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
import type { AssetDriftStateResponse, AssetDriftStateRow } from '@loop/shared';
import { getAssetDriftState } from '../payments/asset-drift-watcher.js';

// A2-1506: `AssetDriftStateRow` / `AssetDriftStateResponse` moved to
// `@loop/shared/admin-assets.ts`. Re-exported for in-file builders +
// any downstream imports that expect them at this path.
export type { AssetDriftStateRow, AssetDriftStateResponse };

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
