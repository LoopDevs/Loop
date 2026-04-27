/**
 * `/api/admin/*` ops-tail route mounts — the residual 14 admin
 * routes that didn\'t fit any of the topical cluster sub-modules
 * (treasury / payouts / orders / users / per-merchant / dashboard /
 * fleet-monthly / operator / cashback-config / credit-writes).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts` as the final
 * extraction slice. Mirrors the openapi splits that scattered the
 * same residual paths across `./openapi/admin-misc-reads.ts`
 * (#1169) + `./openapi/admin-ops-tail.ts` (#1180).
 *
 * Routes:
 *   - GET  /api/admin/orders                    (list)
 *   - GET  /api/admin/merchant-flows
 *   - GET  /api/admin/discord/config
 *   - GET  /api/admin/users/search              (literal — must register before /users/:userId in user-cluster)
 *   - GET  /api/admin/user-credits.csv
 *   - GET  /api/admin/reconciliation
 *   - GET  /api/admin/merchant-stats
 *   - GET  /api/admin/orders/:orderId/payout
 *   - GET  /api/admin/top-users
 *   - GET  /api/admin/audit-tail (+ .csv)
 *   - POST /api/admin/merchants/resync
 *   - GET  /api/admin/discord/notifiers
 *   - POST /api/admin/discord/test
 *
 * **Mount-order discipline** — this factory MUST be called BEFORE
 * `mountAdminUserClusterRoutes`, because the `/users/search` literal
 * (4 segments) here must register BEFORE the `/users/:userId` param
 * (also 4 segments) in the user-cluster sub-factory. Other routes
 * here have unique segment counts and don\'t conflict with anything
 * in other sub-modules.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this factory
 * MUST be called AFTER the 4-piece middleware stack (cache-control /
 * requireAuth / requireAdmin / audit middleware) is in place.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminListOrdersHandler } from '../admin/orders.js';
import { adminMerchantFlowsHandler } from '../admin/merchant-flows.js';
import { adminDiscordConfigHandler } from '../admin/discord-config.js';
import { adminUserSearchHandler } from '../admin/user-search.js';
import { adminUserCreditsCsvHandler } from '../admin/user-credits-csv.js';
import { adminReconciliationHandler } from '../admin/reconciliation.js';
import { adminMerchantStatsHandler } from '../admin/merchant-stats.js';
import { adminPayoutByOrderHandler } from '../admin/payouts.js';
import { adminTopUsersHandler } from '../admin/top-users.js';
import { adminAuditTailHandler } from '../admin/audit-tail.js';
import { adminAuditTailCsvHandler } from '../admin/audit-tail-csv.js';
import { adminMerchantsResyncHandler } from '../admin/merchants-resync.js';
import { adminDiscordNotifiersHandler } from '../admin/discord-notifiers.js';
import { adminDiscordTestHandler } from '../admin/discord-test.js';

/**
 * Mounts the residual ops-tail routes on the supplied Hono app.
 * Called once from `mountAdminRoutes` after the admin middleware
 * stack is in place AND before `mountAdminUserClusterRoutes`.
 */
export function mountAdminOpsTailRoutes(app: Hono): void {
  // Loop-native orders drill-down (ADR 011 / 015). Paginated, filterable
  // by state and userId. Ops uses this to triage stuck orders + audit
  // the cashback split + correlate with operator-pool health.
  app.get('/api/admin/orders', rateLimit(60, 60_000), adminListOrdersHandler);
  // Per-merchant fulfilled-order flow aggregate (ADR 011 / 015). Feeds
  // the per-row "actual split" display on /admin/cashback next to each
  // merchant's configured split.
  app.get('/api/admin/merchant-flows', rateLimit(60, 60_000), adminMerchantFlowsHandler);
  // Webhook configuration status — read-only companion to the ping
  // endpoint. Admin panel polls this to render a "configured"/"missing"
  // badge next to each channel without POSTing.
  app.get('/api/admin/discord/config', rateLimit(60, 60_000), adminDiscordConfigHandler);
  // User search by email fragment (ADR 011 — admin panel navigation).
  // Rate limit matches other reads; the ILIKE query is indexed by the
  // users_email index so it stays fast even on growth.
  app.get('/api/admin/users/search', rateLimit(60, 60_000), adminUserSearchHandler);
  // Tier 3 CSV export of the full user_credits table. Support audit /
  // liability reconciliation. 20/min matches other admin exports.
  app.get('/api/admin/user-credits.csv', rateLimit(20, 60_000), adminUserCreditsCsvHandler);
  // Ledger integrity check (ADR 009 invariant). Left-joins user_credits
  // against the grouped credit_transactions sum; returns drifted rows.
  app.get('/api/admin/reconciliation', rateLimit(30, 60_000), adminReconciliationHandler);
  // Order-drill cluster — orders/activity, orders/payment-method-

  // Per-merchant cashback stats — which merchants drive volume /
  // cashback outlay / margin. Distinct from supplier-spend (currency
  // grouped) — this one groups by merchant.
  app.get('/api/admin/merchant-stats', rateLimit(60, 60_000), adminMerchantStatsHandler);
  // Per-merchant drill cluster + fleet flywheel-share leaderboard

  // Given an order id, return the single pending_payouts row for it.
  // Nested under /orders/:orderId so the UI can link from the order
  // drill-down straight to the payout state without a separate fetch.
  app.get('/api/admin/orders/:orderId/payout', rateLimit(120, 60_000), adminPayoutByOrderHandler);
  // Operator + supplier-spend cluster — supplier-spend (+ activity),

  // Top users by cashback earned — recognition + concentration-risk
  // view for ops. Ranked, window-bounded; not a drill path.
  app.get('/api/admin/top-users', rateLimit(60, 60_000), adminTopUsersHandler);
  // Newest-first tail of admin_idempotency_keys (ADR 017/018). Powers
  // the "recent admin activity" card on the /admin landing. Same row
  // as the Discord audit fanout but persistent + queryable. Actor
  // email joined in so the UI doesn't need a follow-up lookup.
  app.get('/api/admin/audit-tail', rateLimit(60, 60_000), adminAuditTailHandler);
  // Finance / legal CSV export of the admin write-audit trail
  // (ADR 017 / 018). SOC-2 and finance audits want a month of
  // rows exportable in a neutral format. 10/min rate-limit mirrors
  // the other Tier-3 CSV exports — ops runs this manually at
  // month-end, not on-click from the UI.
  app.get('/api/admin/audit-tail.csv', rateLimit(10, 60_000), adminAuditTailCsvHandler);
  // User cluster — directory + lookups + per-user drill

  // Manual merchant-catalog resync (ADR 011). Bypasses the 6h
  // scheduled refresh so ops can apply an upstream catalog change
  // within seconds. 2/min rate limit — every hit goes to CTX, this
  // is a manual override not a polled surface.
  app.post('/api/admin/merchants/resync', rateLimit(2, 60_000), adminMerchantsResyncHandler);
  // Discord notifier catalog (ADR 018). Static read of the
  // DISCORD_NOTIFIERS const — the admin UI renders "what signals can
  // this system send us?" from this list. No DB, no secrets.
  app.get('/api/admin/discord/notifiers', rateLimit(60, 60_000), adminDiscordNotifiersHandler);
  // Manual Discord test ping. Admin picks a channel, backend fires a
  // benign embed at the configured webhook so ops can verify wiring
  // after rotating env vars. 10/min — this is a manual ops primitive,
  // spamming looks like webhook enumeration.
  app.post('/api/admin/discord/test', rateLimit(10, 60_000), adminDiscordTestHandler);
}
