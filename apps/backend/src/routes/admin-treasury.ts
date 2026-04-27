/**
 * `/api/admin/treasury*` + `/api/admin/assets/*` route mounts
 * (ADR 009 / 015 / 016 / 018).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Five routes
 * that back the ADR-015 ledger ↔ chain reconciliation surface —
 * same routes the openapi spec splits into
 * `./openapi/admin-treasury-assets.ts` (#1179):
 *
 *   - GET /api/admin/treasury                       (snapshot)
 *   - GET /api/admin/treasury.csv                   (Tier-3 CSV)
 *   - GET /api/admin/treasury/credit-flow           (per-day series)
 *   - GET /api/admin/assets/:assetCode/circulation  (drift)
 *   - GET /api/admin/asset-drift/state              (watcher state)
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { treasuryHandler } from '../admin/treasury.js';
import { adminTreasurySnapshotCsvHandler } from '../admin/treasury-snapshot-csv.js';
import { adminTreasuryCreditFlowHandler } from '../admin/treasury-credit-flow.js';
import { adminAssetCirculationHandler } from '../admin/asset-circulation.js';
import { adminAssetDriftStateHandler } from '../admin/asset-drift-state.js';

/**
 * Mounts the treasury / asset-drift routes on the supplied Hono
 * app. Called once from `mountAdminRoutes` after the admin
 * middleware stack is in place.
 */
export function mountAdminTreasuryRoutes(app: Hono): void {
  app.get('/api/admin/treasury', rateLimit(60, 60_000), treasuryHandler);
  // Tier-3 CSV of the treasury snapshot (ADR 009/015/018). Point-
  // in-time flat dump for SOC-2 / audit evidence. Long-form CSV
  // (metric,key,value) — diffable across successive snapshots so
  // auditors can eyeball "what moved between Monday and Tuesday".
  // Reuses the JSON snapshot handler; no new DB query.
  app.get('/api/admin/treasury.csv', rateLimit(10, 60_000), adminTreasurySnapshotCsvHandler);
  // Treasury credit-flow time-series (ADR 009/015) — per-day credited
  // vs debited per currency from credit_transactions. Answers "are we
  // generating liability faster than we settle it?" — the dynamic
  // view the treasury snapshot can't give.
  app.get('/api/admin/treasury/credit-flow', rateLimit(60, 60_000), adminTreasuryCreditFlowHandler);
  // Per-asset circulation drift (ADR 015). Compares Horizon-side
  // issued circulation against off-chain ledger liability — the
  // stablecoin-operator safety metric. 30/min: admin drill page,
  // not a dashboard card; Horizon calls are cached 30s internally.
  app.get(
    '/api/admin/assets/:assetCode/circulation',
    rateLimit(30, 60_000),
    adminAssetCirculationHandler,
  );
  // In-memory snapshot of the asset-drift watcher's per-asset state
  // (ADR 015). Process-local, no Horizon call; cheap to poll from the
  // admin UI landing so the "which assets are drifted?" signal reads
  // without forcing each tab to re-read Horizon.
  app.get('/api/admin/asset-drift/state', rateLimit(120, 60_000), adminAssetDriftStateHandler);
}
