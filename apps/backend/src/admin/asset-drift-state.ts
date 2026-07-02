/**
 * Admin asset-drift state (ADR 015).
 *
 * `GET /api/admin/asset-drift/state` — surfaces the persisted state
 * of the background drift watcher (see
 * `apps/backend/src/payments/asset-drift-watcher.ts`). Lets the
 * admin UI render "which LOOP assets are currently over threshold /
 * carrying failed money-movement rows" without each browser-load
 * re-polling Horizon.
 *
 * The watcher fires every 300s by default, reads Horizon for each
 * configured LOOP asset, and persists the drift value + over/ok
 * classification (+ the failed burn/interest-mint dimension,
 * hardening A2) in the `asset_drift_state` table — fleet-consistent
 * and restart-durable (hardening A3). This endpoint is a cheap dump
 * of those rows. If the operator wants a fresh number they can hit
 * the existing per-asset circulation endpoint which forces a
 * Horizon read.
 *
 * Returns 200 with a `perAsset: []` when the watcher hasn't been
 * started (no LOOP issuers configured). Clients render "watcher
 * inactive" from `running: false` rather than showing a zero-state
 * that implies healthy drift.
 */
import type { Context } from 'hono';
import type { AssetDriftStateResponse, AssetDriftStateRow } from '@loop/shared';
import { getAssetDriftState } from '../payments/asset-drift-watcher.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-asset-drift-state' });

// A2-1506: `AssetDriftStateRow` / `AssetDriftStateResponse` moved to
// `@loop/shared/admin-assets.ts`. Re-exported for in-file builders +
// any downstream imports that expect them at this path.
export type { AssetDriftStateRow, AssetDriftStateResponse };

export async function adminAssetDriftStateHandler(c: Context): Promise<Response> {
  let state: Awaited<ReturnType<typeof getAssetDriftState>>;
  try {
    state = await getAssetDriftState();
  } catch (err) {
    // The snapshot is now a DB read (hardening A3) — a DB outage
    // must degrade this poll endpoint gracefully, not stack-trace.
    log.error({ err }, 'Admin asset-drift state read failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to read drift state' }, 500);
  }
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
      failedRowsState: a.failedRowsState,
      failedBurnStroops: a.failedBurnStroops === null ? null : a.failedBurnStroops.toString(),
      failedInterestMintStroops:
        a.failedInterestMintStroops === null ? null : a.failedInterestMintStroops.toString(),
    })),
  };
  return c.json(body);
}
