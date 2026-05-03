/**
 * `/api/admin/payouts*` route mounts (ADR 015 / 016 / 017 / 024).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts` to keep that
 * file under the soft cap. Six payouts-cluster routes that back
 * the `/admin/payouts` UI surface — list + drill + by-asset
 * breakdown + settlement-lag SLA + retry + compensate + CSV
 * export. Mirrors the openapi/admin-payouts-cluster.ts split
 * (#1178).
 *
 * Mount-order discipline preserved verbatim — Hono resolves routes
 * in registration order, and `/payouts/:id` (param-only) is
 * registered AFTER the literal-prefixed `/payouts-by-asset` and
 * before the literal-suffix `/payouts/:id/retry|compensate` so
 * the URL-template tree resolves the way the original mount did.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that's the parent factory's responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { killSwitch } from '../middleware/kill-switch.js';
import {
  adminGetPayoutHandler,
  adminListPayoutsHandler,
  adminRetryPayoutHandler,
} from '../admin/payouts.js';
import { adminPayoutsCsvHandler } from '../admin/payouts-csv.js';
import { adminPayoutCompensationHandler } from '../admin/payout-compensation.js';
import { adminPayoutsByAssetHandler } from '../admin/payouts-by-asset.js';
import { adminSettlementLagHandler } from '../admin/settlement-lag.js';

/**
 * Mounts the `/api/admin/payouts*` routes on the supplied Hono
 * app. Called once from `mountAdminRoutes` after the admin
 * middleware stack is in place.
 */
export function mountAdminPayoutsRoutes(app: Hono): void {
  // Pending-payouts backlog list (ADR 015). Admin UI's "payouts" page
  // drills into pending/submitted/confirmed/failed rows; counts for the
  // at-a-glance card come from the treasury snapshot above.
  app.get(
    '/api/admin/payouts',
    rateLimit('GET /api/admin/payouts', 60, 60_000),
    adminListPayoutsHandler,
  );
  // Per-asset payout breakdown — crosses asset_code × state for the
  // LOOP stablecoin triage view (ADR 015/016). Admin UI renders this
  // on the treasury page as a per-asset table next to the flat payout
  // list, so an incident in one asset doesn't get lost in the volume
  // of another.
  app.get(
    '/api/admin/payouts-by-asset',
    rateLimit('GET /api/admin/payouts-by-asset', 60, 60_000),
    adminPayoutsByAssetHandler,
  );
  // A4-075: literal routes BEFORE parameter siblings, otherwise
  // Hono's TrieRouter resolves `/api/admin/payouts/settlement-lag`
  // against the `:id` pattern with `id='settlement-lag'`, calling
  // adminGetPayoutHandler (uuid validation rejects). The literal
  // settlement-lag handler must register before `/:id`.
  // Settlement-lag SLA — p50/p95/max seconds from pending_payouts row
  // insert to on-chain confirmation, windowed. One row per LOOP asset
  // plus a fleet-wide aggregate (`assetCode: null`). The SLA signal
  // operators watch alongside drift: if payouts are taking hours, the
  // drift number will grow regardless of minting health.
  app.get(
    '/api/admin/payouts/settlement-lag',
    rateLimit('GET /api/admin/payouts/settlement-lag', 60, 60_000),
    adminSettlementLagHandler,
  );
  // GET /api/admin/payouts/:id — single-row drill-down (permalink for
  // an ops ticket / incident note). Higher rate limit than the list
  // because the admin UI deep-links individual rows on every navigation.
  // Registered AFTER /settlement-lag literal per A4-075.
  app.get(
    '/api/admin/payouts/:id',
    rateLimit('GET /api/admin/payouts/:id', 120, 60_000),
    adminGetPayoutHandler,
  );
  // POST /api/admin/payouts/:id/retry — flip a failed row back to pending.
  // Lower rate limit: retries should be rare, one-at-a-time ops actions.
  app.post(
    '/api/admin/payouts/:id/retry',
    rateLimit('POST /api/admin/payouts/:id/retry', 20, 60_000),
    adminRetryPayoutHandler,
  );
  // POST /api/admin/payouts/:id/compensate — re-credit a user after a
  // permanently-failed withdrawal payout (ADR-024 §5). Same rate limit
  // as retry: rare, finance-reviewed, one-at-a-time.
  app.post(
    '/api/admin/payouts/:id/compensate',
    killSwitch('withdrawals'),
    rateLimit('POST /api/admin/payouts/:id/compensate', 20, 60_000),
    adminPayoutCompensationHandler,
  );
  // Finance-ready CSV export of pending_payouts rows. Lower rate
  // limit than the JSON list because exports scan rows 500× the
  // size of a pagination fetch.
  app.get(
    '/api/admin/payouts.csv',
    rateLimit('GET /api/admin/payouts.csv', 10, 60_000),
    adminPayoutsCsvHandler,
  );
}
