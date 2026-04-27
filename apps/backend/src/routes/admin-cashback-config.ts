/**
 * `/api/admin/merchant-cashback-configs*` route mounts (ADR 011 / 018).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. Six routes
 * covering the cashback-config CRUD surface plus the closely-
 * related merchants-catalog CSV export — same routes the openapi
 * spec splits between `./openapi/admin-cashback-config.ts` (#1166,
 * five routes) and `./openapi/admin-csv-exports.ts` (the
 * merchants-catalog.csv lives alongside the other Tier-3 CSVs there).
 *
 * Mount-order discipline preserved verbatim:
 *
 *   - the `.csv` literal endpoints register BEFORE the
 *     `/:merchantId` PUT, otherwise Hono\'s URL-template tree would
 *     capture `.csv` as a merchantId.
 *   - the fleet-wide `/history` literal registers BEFORE
 *     `/:merchantId/history` for the same reason.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { listConfigsHandler, upsertConfigHandler, configHistoryHandler } from '../admin/handler.js';
import { adminConfigsHistoryHandler } from '../admin/configs-history.js';
import { adminCashbackConfigsCsvHandler } from '../admin/cashback-configs-csv.js';
import { adminMerchantsCatalogCsvHandler } from '../admin/merchants-catalog-csv.js';

/**
 * Mounts the cashback-config CRUD + merchants-catalog CSV routes
 * on the supplied Hono app. Called once from `mountAdminRoutes`
 * after the admin middleware stack is in place.
 */
export function mountAdminCashbackConfigRoutes(app: Hono): void {
  app.get('/api/admin/merchant-cashback-configs', rateLimit(120, 60_000), listConfigsHandler);
  // CSV export of merchant_cashback_configs — Tier-3 bulk per ADR 018.
  // 10/min rate-limit matches the other admin CSVs; ops runs this at
  // audit cadence, not on-click from the UI. Registered before the
  // :merchantId routes below so the literal `.csv` segment isn't
  // treated as a merchantId.
  app.get(
    '/api/admin/merchant-cashback-configs.csv',
    rateLimit(10, 60_000),
    adminCashbackConfigsCsvHandler,
  );
  // Tier-3 CSV export of the full merchant catalog + joined
  // cashback-config state (#653). Finance / BD runs this to see
  // every merchant + current commercial terms in one spreadsheet.
  // Catalog is the source of truth — evicted merchants drop out,
  // stale config rows are filtered out by the join.
  app.get(
    '/api/admin/merchants-catalog.csv',
    rateLimit(10, 60_000),
    adminMerchantsCatalogCsvHandler,
  );
  // Fleet-wide history feed — "the last N config changes across every
  // merchant". Registered before /:merchantId/history so the literal
  // `history` segment isn't captured as a merchantId. ADR 011 / 018.
  app.get(
    '/api/admin/merchant-cashback-configs/history',
    rateLimit(120, 60_000),
    adminConfigsHistoryHandler,
  );
  app.put(
    '/api/admin/merchant-cashback-configs/:merchantId',
    rateLimit(60, 60_000),
    upsertConfigHandler,
  );
  app.get(
    '/api/admin/merchant-cashback-configs/:merchantId/history',
    rateLimit(120, 60_000),
    configHistoryHandler,
  );
}
