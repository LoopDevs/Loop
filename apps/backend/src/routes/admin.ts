/**
 * `/api/admin/*` route mounts. Pulled out of `app.ts` as the
 * seventh and final per-domain route module after public / misc /
 * merchants / auth / orders / users.
 *
 * The admin surface bundles four things together because their
 * mount ORDER is the contract:
 *
 * 1. **Cache-Control: private, no-store** mounts FIRST so the
 *    header lands on every response, including 401 / 403 envelopes
 *    emitted by `requireAuth` / `requireAdmin`. A2-1010 — every
 *    handler under this namespace returns operator-visible data
 *    (treasury snapshots, per-user credit history, audit events,
 *    CSV exports of the ledger). A CDN keyed on URL alone — not
 *    Authorization — must not cache one of these. Registered
 *    BEFORE `requireAuth` so a 401 / 403 response also carries
 *    no-store; otherwise a misbehaving CDN caching 401 envelopes
 *    leaks "this URL is admin-only" cross-user.
 * 2. **`requireAuth`** mounts SECOND so the actor identity is
 *    attached before `requireAdmin` checks it. Order matters:
 *    requireAdmin runs AFTER requireAuth so an unauth'd request
 *    gets a 401 (clearer error envelope shape) rather than 403.
 * 3. **`requireAdmin`** mounts THIRD — upserts the Loop user row
 *    if missing, gates on `is_admin`, sets `c.get('user')` for the
 *    audit-log middleware below.
 * 4. **Admin read audit middleware** (A2-2008) mounts FOURTH —
 *    runs AFTER requireAuth/requireAdmin so the actor identity is
 *    available, and BEFORE the handler so the request body is
 *    unbuffered. Every admin GET emits a Pino access-log line
 *    tagged `audit-read`; bulk reads (CSV downloads) additionally
 *    fire a Discord ping in #admin-audit. Single-row drills stay
 *    log-only — sending every drill to Discord would flood the
 *    channel and dilute the signal on real bulk-exfil patterns.
 *
 * Endpoint groups inside the factory (rate limits in parens):
 *
 * - **Cashback config (4)** — list, CSV, fleet history, per-merchant
 *   upsert + history (ADR 011 / 018).
 * - **Treasury (3)** — snapshot, snapshot CSV, credit-flow time
 *   series (ADR 009 / 015).
 * - **Asset circulation + drift (2)** — per-asset Horizon-vs-ledger
 *   drift, in-memory drift watcher state (ADR 015).
 * - **Payouts (~10)** — list, by-id drill, by-asset, by-order,
 *   settlement-lag SLA, retry, compensation, CSV, monthly,
 *   activity, activity CSV.
 * - **Orders (~6)** — list, drill, CSV, activity, payment-method
 *   share + activity (ADR 011 / 015).
 * - **Stuck triage (2)** — stuck orders, stuck payouts.
 * - **Cashback realization + activity + monthly (~8)** — fleet-
 *   wide cashback metrics + finance CSVs (ADR 009 / 015).
 * - **Supplier spend + operator stats + mix-axis (~10)** —
 *   ADR 013 / 022 mix-axis matrix: per-merchant operator-mix,
 *   per-operator merchant-mix, per-user operator-mix, plus
 *   per-operator activity / supplier-spend / latency.
 * - **Merchant fleet stats + flywheel + per-merchant drill (~12)**
 *   — fleet stats + CSV, flywheel-share leaderboard + CSV,
 *   per-merchant flywheel-stats / cashback-summary / payment-
 *   method-share / cashback-monthly / flywheel-activity / top-
 *   earners.
 * - **User search + drill (~12)** — paginated list, by-email
 *   exact, top-by-pending-payout, recycling-activity (+ CSV),
 *   per-user detail / credits / cashback-by-merchant /
 *   cashback-summary / flywheel-stats / payment-method-share /
 *   cashback-monthly / credit-transactions (+ CSV) / operator-
 *   mix, plus writes (refunds / credit-adjustments / withdrawals)
 *   each gated by ADR-017 idempotency.
 * - **Resync + Discord (~3)** — manual merchant-catalog resync,
 *   Discord notifier catalog read, manual Discord test ping.
 * - **Audit tail (2)** — admin write-audit tail (ADR 017 / 018)
 *   and finance / legal CSV export.
 *
 * Mount-order discipline (literal-vs-param) is preserved verbatim
 * from the original mounts because Hono resolves routes in
 * registration order — see e.g. `/users/by-email` registered
 * before `/users/:userId` so the `by-email` literal isn't
 * captured as a uuid param.
 */
import type { Context, Hono } from 'hono';
import { logger } from '../logger.js';
import type { User } from '../db/users.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { killSwitch } from '../middleware/kill-switch.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import { requireAdmin } from '../auth/require-admin.js';
import { notifyAdminBulkRead } from '../discord.js';
import { listConfigsHandler, upsertConfigHandler, configHistoryHandler } from '../admin/handler.js';
import { adminConfigsHistoryHandler } from '../admin/configs-history.js';
import { treasuryHandler } from '../admin/treasury.js';
import { adminTreasurySnapshotCsvHandler } from '../admin/treasury-snapshot-csv.js';
import { adminTreasuryCreditFlowHandler } from '../admin/treasury-credit-flow.js';
import { adminAssetCirculationHandler } from '../admin/asset-circulation.js';
import { adminAssetDriftStateHandler } from '../admin/asset-drift-state.js';
import { adminPayoutByOrderHandler } from '../admin/payouts.js';
import { mountAdminPayoutsRoutes } from './admin-payouts.js';
import { adminTopUsersHandler } from '../admin/top-users.js';
import { adminTopUsersByPendingPayoutHandler } from '../admin/top-users-by-pending-payout.js';
import { adminUsersRecyclingActivityHandler } from '../admin/users-recycling-activity.js';
import { adminUsersRecyclingActivityCsvHandler } from '../admin/users-recycling-activity-csv.js';
import { adminAuditTailHandler } from '../admin/audit-tail.js';
import { adminAuditTailCsvHandler } from '../admin/audit-tail-csv.js';
import { adminGetOrderHandler, adminListOrdersHandler } from '../admin/orders.js';
import { adminMerchantFlowsHandler } from '../admin/merchant-flows.js';
import { adminDiscordConfigHandler } from '../admin/discord-config.js';
import { adminUserSearchHandler } from '../admin/user-search.js';
import { adminUserCreditsCsvHandler } from '../admin/user-credits-csv.js';
import { adminReconciliationHandler } from '../admin/reconciliation.js';
import { adminOrdersActivityHandler } from '../admin/orders-activity.js';
import { adminPaymentMethodShareHandler } from '../admin/payment-method-share.js';
import { adminPaymentMethodActivityHandler } from '../admin/payment-method-activity.js';
import { adminOrdersCsvHandler } from '../admin/orders-csv.js';
import { adminStuckOrdersHandler } from '../admin/stuck-orders.js';
import { adminStuckPayoutsHandler } from '../admin/stuck-payouts.js';
import { adminCashbackActivityHandler } from '../admin/cashback-activity.js';
import { adminCashbackActivityCsvHandler } from '../admin/cashback-activity-csv.js';
import { adminCashbackRealizationHandler } from '../admin/cashback-realization.js';
import { adminCashbackRealizationDailyHandler } from '../admin/cashback-realization-daily.js';
import { adminCashbackRealizationDailyCsvHandler } from '../admin/cashback-realization-daily-csv.js';
import { adminCashbackMonthlyHandler } from '../admin/cashback-monthly.js';
import { adminPayoutsMonthlyHandler } from '../admin/payouts-monthly.js';
import { adminPayoutsActivityHandler } from '../admin/payouts-activity.js';
import { adminPayoutsActivityCsvHandler } from '../admin/payouts-activity-csv.js';
import { adminSupplierSpendActivityCsvHandler } from '../admin/supplier-spend-activity-csv.js';
import { adminOperatorsSnapshotCsvHandler } from '../admin/operators-snapshot-csv.js';
import { adminTreasuryCreditFlowCsvHandler } from '../admin/treasury-credit-flow-csv.js';
import { adminMerchantStatsHandler } from '../admin/merchant-stats.js';
import { adminMerchantStatsCsvHandler } from '../admin/merchant-stats-csv.js';
import { adminMerchantsFlywheelShareHandler } from '../admin/merchants-flywheel-share.js';
import { adminMerchantsFlywheelShareCsvHandler } from '../admin/merchants-flywheel-share-csv.js';
import { adminMerchantFlywheelStatsHandler } from '../admin/merchant-flywheel-stats.js';
import { adminMerchantCashbackSummaryHandler } from '../admin/merchant-cashback-summary.js';
import { adminMerchantPaymentMethodShareHandler } from '../admin/merchant-payment-method-share.js';
import { adminMerchantCashbackMonthlyHandler } from '../admin/merchant-cashback-monthly.js';
import { adminMerchantFlywheelActivityHandler } from '../admin/merchant-flywheel-activity.js';
import { adminMerchantFlywheelActivityCsvHandler } from '../admin/merchant-flywheel-activity-csv.js';
import { adminMerchantTopEarnersHandler } from '../admin/merchant-top-earners.js';
import { adminCashbackConfigsCsvHandler } from '../admin/cashback-configs-csv.js';
import { adminMerchantsCatalogCsvHandler } from '../admin/merchants-catalog-csv.js';
import { adminSupplierSpendHandler } from '../admin/supplier-spend.js';
import { adminSupplierSpendActivityHandler } from '../admin/supplier-spend-activity.js';
import { adminOperatorSupplierSpendHandler } from '../admin/operator-supplier-spend.js';
import { adminOperatorActivityHandler } from '../admin/operator-activity.js';
import { adminOperatorStatsHandler } from '../admin/operator-stats.js';
import { adminOperatorLatencyHandler } from '../admin/operator-latency.js';
import { adminMerchantOperatorMixHandler } from '../admin/merchant-operator-mix.js';
import { adminOperatorMerchantMixHandler } from '../admin/operator-merchant-mix.js';
import { adminUserOperatorMixHandler } from '../admin/user-operator-mix.js';
import { adminUserCreditsHandler } from '../admin/user-credits.js';
import { adminUserCreditTransactionsHandler } from '../admin/user-credit-transactions.js';
import { adminUserCreditTransactionsCsvHandler } from '../admin/user-credit-transactions-csv.js';
import { adminUserCashbackByMerchantHandler } from '../admin/user-cashback-by-merchant.js';
import { adminUserCashbackSummaryHandler } from '../admin/user-cashback-summary.js';
import { adminUserFlywheelStatsHandler } from '../admin/user-flywheel-stats.js';
import { adminUserPaymentMethodShareHandler } from '../admin/user-payment-method-share.js';
import { adminUserCashbackMonthlyHandler } from '../admin/user-cashback-monthly.js';
import { adminGetUserHandler } from '../admin/user-detail.js';
import { adminUserByEmailHandler } from '../admin/user-by-email.js';
import { adminListUsersHandler } from '../admin/users-list.js';
import { adminMerchantsResyncHandler } from '../admin/merchants-resync.js';
import { adminDiscordNotifiersHandler } from '../admin/discord-notifiers.js';
import { adminDiscordTestHandler } from '../admin/discord-test.js';
import { adminCreditAdjustmentHandler } from '../admin/credit-adjustments.js';
import { adminRefundHandler } from '../admin/refunds.js';
import { adminWithdrawalHandler } from '../admin/withdrawals.js';

/** Mounts all `/api/admin/*` routes on the supplied Hono app. */
export function mountAdminRoutes(app: Hono): void {
  // ─── Admin (authenticated + admin-flagged) ──────────────────────────────────
  //
  // Cashback config CRUD (ADR 011). Layered middleware: requireAuth to
  // attach the bearer, then requireAdmin to upsert the Loop user row,
  // gate on is_admin, and set c.get('user'). Rate-limited same as the
  // other authenticated surfaces — an admin still hits the limiter,
  // but the limits are generous since it's a low-volume UI.
  // A2-1010: force Cache-Control: private, no-store on every admin
  // response. Every handler under this namespace returns operator-
  // visible data (treasury snapshots, per-user credit history, audit
  // events, CSV exports of the ledger), so a CDN / intermediate proxy
  // keyed on URL alone — not Authorization — must not cache a response.
  // Mirror of the `/api/orders` + `/api/users/me` pattern above; the
  // individual CSV handlers already set it on the happy path, but this
  // namespace-level middleware guarantees the header also lands on 4xx
  // / 5xx responses (where a handler that threw never reached its own
  // `c.header(...)` call). Registered BEFORE requireAuth so a 401 /
  // 403 response emitted by the auth middleware also carries no-store
  // — a misbehaving CDN caching 401 / 403 envelopes shouldn't leak
  // "this URL is admin-only" cross-user.
  app.use('/api/admin/*', privateNoStoreResponse);

  app.use('/api/admin/*', requireAuth);
  app.use('/api/admin/*', requireAdmin);

  // A2-2008: admin read audit. Every admin GET emits a Pino access-log
  // line tagged `audit-read` so the line-item read trail survives off
  // the host (Fly logflow ships logs externally — harder to tamper with
  // than a DB row). Bulk reads (CSV downloads + sufficiently-large list
  // pulls) additionally fire a Discord ping in #admin-audit so a human
  // sees the export-in-progress signal alongside the existing write
  // stream. Single-row drills stay log-only — sending every drill to
  // Discord would flood the channel and dilute the signal on real
  // bulk-exfil patterns.
  app.use('/api/admin/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET') return;
    if (c.res.status !== 200) return;
    const actor = (c as unknown as Context).get('user') as User | undefined;
    if (actor === undefined) return;

    const path = c.req.path;
    const query = c.req.url.split('?')[1] ?? '';
    const isCsv = path.endsWith('.csv');

    logger.info(
      {
        area: 'admin-read-audit',
        actorUserId: actor.id,
        method: c.req.method,
        path,
        query: query.length > 0 ? query.slice(0, 200) : undefined,
        isBulk: isCsv,
      },
      'Admin read',
    );

    if (isCsv) {
      notifyAdminBulkRead({
        actorUserId: actor.id,
        endpoint: `${c.req.method} ${path}`,
        ...(query.length > 0 ? { queryString: query } : {}),
      });
    }
  });

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
  // Payouts cluster — list + drill + by-asset + settlement-lag SLA
  // + retry + compensate + CSV (ADR 015/016/017/024). Lifted into
  // ./admin-payouts.ts; the sub-factory mounts these 7 routes after
  // the parent's middleware stack is already in place.
  mountAdminPayoutsRoutes(app);

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
  // 7-day (or N-day, clamped 1-90) order-activity sparkline. Drives the
  // admin dashboard's "created vs fulfilled per day" chart. Single
  // generate_series + LEFT JOIN; every day in the window appears with
  // zero-filled counts when no orders crossed. Registered before
  // `/:orderId` so the literal `/activity` matches first.
  app.get('/api/admin/orders/activity', rateLimit(60, 60_000), adminOrdersActivityHandler);
  // Payment-method share aggregate — the cashback-flywheel metric.
  // Tracks the proportion of orders paid with each rail (xlm / usdc /
  // credit / loop_asset). ADR 010 / 015's strategy assumes a rising
  // loop_asset share once users have cashback to recycle; this is how
  // ops reads that. Registered before /:orderId so the literal
  // 'payment-method-share' doesn't get captured as an orderId.
  app.get(
    '/api/admin/orders/payment-method-share',
    rateLimit(60, 60_000),
    adminPaymentMethodShareHandler,
  );
  // Time-series complement to /payment-method-share. Same four-rail
  // shape but bucketed per UTC day, capped at 90d, so the trend side
  // of the flywheel signal is observable — share is "where are we
  // now", activity is "where are we going". Registered before
  // /:orderId for the same literal-vs-param reason as its sibling.
  app.get(
    '/api/admin/orders/payment-method-activity',
    rateLimit(60, 60_000),
    adminPaymentMethodActivityHandler,
  );
  // Single-order drill-down (ADR 011 / 015). Permalink for an ops
  // ticket or incident note. Higher rate-limit than the list because
  // the admin UI re-fetches detail on every navigation.
  app.get('/api/admin/orders/:orderId', rateLimit(120, 60_000), adminGetOrderHandler);
  // Finance-ready CSV export of Loop-native orders. Same rate-limit
  // cadence as other Tier-3 exports — ops runs it manually at month-end,
  // not on-click from the UI.
  app.get('/api/admin/orders.csv', rateLimit(10, 60_000), adminOrdersCsvHandler);
  // Stuck-orders triage. Dashboard pings this every 30-60s — higher
  // rate limit because the admin UI polls it on a loop to surface
  // an SLO red-flag card.
  app.get('/api/admin/stuck-orders', rateLimit(120, 60_000), adminStuckOrdersHandler);
  // Stuck-payouts triage — pending_payouts rows in pending/submitted
  // past the SLO threshold (ADR 015/016). Same 120/min polling budget
  // as stuck-orders since both feed the same dashboard card and often
  // refetch together.
  app.get('/api/admin/stuck-payouts', rateLimit(120, 60_000), adminStuckPayoutsHandler);
  // Daily cashback-accrual time-series for the dashboard sparkline.
  // Cheap read — single generate_series + LEFT JOIN, bounded at 180
  // days so the payload can't explode.
  app.get('/api/admin/cashback-activity', rateLimit(60, 60_000), adminCashbackActivityHandler);
  // Cashback realization rate — per-currency earned vs spent vs
  // outstanding, plus a fleet-wide aggregate row. The flywheel-health
  // KPI: high realization = users recycling cashback into new orders
  // rather than hoarding or withdrawing (ADR 009/015).
  app.get(
    '/api/admin/cashback-realization',
    rateLimit(60, 60_000),
    adminCashbackRealizationHandler,
  );
  // Daily realization time-series — per-(day, currency) earned +
  // spent + recycledBps. Drift-over-time companion to the single-point
  // realization surface above; powers the sparkline on /admin landing.
  app.get(
    '/api/admin/cashback-realization/daily',
    rateLimit(60, 60_000),
    adminCashbackRealizationDailyHandler,
  );
  // Finance-ready CSV of the daily realization trend. Tier-3 10/min
  // rate limit + `private, no-store` + attachment disposition — same
  // discipline as the other month-end exports.
  app.get(
    '/api/admin/cashback-realization/daily.csv',
    rateLimit(10, 60_000),
    adminCashbackRealizationDailyCsvHandler,
  );
  // Finance-ready CSV: daily × per-currency cashback accrual. Same
  // aggregate as the JSON surface, flattened for spreadsheet use.
  // Tier-3 rate limit — month-end finance use, not polling.
  app.get(
    '/api/admin/cashback-activity.csv',
    rateLimit(10, 60_000),
    adminCashbackActivityCsvHandler,
  );
  // Fleet-wide monthly-cashback bar chart — per-(month, currency)
  // emission totals over a fixed 12-month window. Mirrors the user-
  // facing /api/users/me/cashback-monthly shape so the same chart
  // component can render either. Single aggregate query.
  app.get('/api/admin/cashback-monthly', rateLimit(60, 60_000), adminCashbackMonthlyHandler);
  // Monthly confirmed-payout totals (#631) — settlement-side
  // counterpart to cashback-monthly. Cashback-monthly measures
  // liability creation (credits minted); this measures liability
  // settlement (confirmed on-chain payouts). Pairing the two
  // answers "is outstanding liability growing or shrinking this
  // month?". Same 12-month window + oldest-first ordering.
  app.get('/api/admin/payouts-monthly', rateLimit(60, 60_000), adminPayoutsMonthlyHandler);
  // Daily payouts-activity (#637) — settlement-side sparkline
  // counterpart to cashback-activity. Same ?days window (default
  // 30, max 180), LEFT-JOIN generate_series so zero-days render
  // as empty byAsset[]. Drives the payout-trend sparkline on
  // /admin/treasury.
  app.get('/api/admin/payouts-activity', rateLimit(60, 60_000), adminPayoutsActivityHandler);
  // Tier-3 CSV export of the same aggregate (#638) — finance runs
  // this alongside /api/admin/cashback-activity.csv at month-end
  // to reconcile liability creation vs. settlement. Rate-limited
  // 10/min per ADR 018.
  app.get('/api/admin/payouts-activity.csv', rateLimit(10, 60_000), adminPayoutsActivityCsvHandler);
  // Tier-3 CSV export of supplier-spend activity (ADR 013/015/018) —
  // finance runs this at month-end to reconcile CTX's invoice: the
  // wholesale_minor column per (day, currency) should tie to CTX's
  // line items. Pairs with cashback-activity.csv (what we minted)
  // and payouts-activity.csv (what we settled).
  app.get(
    '/api/admin/supplier-spend/activity.csv',
    rateLimit(10, 60_000),
    adminSupplierSpendActivityCsvHandler,
  );
  // Tier-3 CSV of the fleet operator snapshot (ADR 013 / 018 / 022)
  // — joins operator-stats + operator-latency into one row per
  // operator. Handed to CTX relationship owners for quarterly
  // review meetings (SLA + volume + success rate on one sheet).
  app.get(
    '/api/admin/operators-snapshot.csv',
    rateLimit(10, 60_000),
    adminOperatorsSnapshotCsvHandler,
  );
  // Tier-3 CSV of the credit-flow time series (ADR 009 / 015 / 018).
  // Completes the finance-CSV quartet: cashback-activity (minted) +
  // payouts-activity (settled on-chain) + supplier-spend/activity
  // (paid to CTX) + this (net ledger movement).
  app.get(
    '/api/admin/treasury/credit-flow.csv',
    rateLimit(10, 60_000),
    adminTreasuryCreditFlowCsvHandler,
  );
  // Per-merchant cashback stats — which merchants drive volume /
  // cashback outlay / margin. Distinct from supplier-spend (currency
  // grouped) — this one groups by merchant.
  app.get('/api/admin/merchant-stats', rateLimit(60, 60_000), adminMerchantStatsHandler);
  // Per-merchant × per-operator mix (ADR 013 / 022). The
  // merchant-axis complement to operator-stats: lives under
  // /merchants/:merchantId so an incident triage landing on
  // /admin/merchants/:id can ask "which operator is primarily
  // carrying this merchant right now?". Complements the fleet
  // operator-stats + the per-operator drill quartet.
  app.get(
    '/api/admin/merchants/:merchantId/operator-mix',
    rateLimit(120, 60_000),
    adminMerchantOperatorMixHandler,
  );
  // Finance / negotiation CSV — flattened per-merchant stats for
  // the CTX rate-deck spreadsheet. Tier-3 rate limit matches the
  // other admin CSV exports.
  app.get('/api/admin/merchant-stats.csv', rateLimit(10, 60_000), adminMerchantStatsCsvHandler);
  // Per-merchant flywheel leaderboard — which merchants see the most
  // recycled-cashback traffic. Merchant-axis cousin of /orders/payment-
  // method-share (fleet) + /orders/payment-method-activity (time).
  // Zero-recycle merchants filtered out; sorted by recycled-count desc.
  app.get(
    '/api/admin/merchants/flywheel-share',
    rateLimit(60, 60_000),
    adminMerchantsFlywheelShareHandler,
  );
  // Tier-3 CSV snapshot of the merchant flywheel leaderboard —
  // finance / CTX-negotiation export. Same aggregate as the JSON,
  // flattened for spreadsheet consumption. 10/min rate limit matches
  // every other admin CSV.
  app.get(
    '/api/admin/merchants/flywheel-share.csv',
    rateLimit(10, 60_000),
    adminMerchantsFlywheelShareCsvHandler,
  );
  // Per-merchant scalar flywheel stats — the single-merchant drill
  // mirror of the fleet leaderboard. Drives a chip on the
  // /admin/merchants/:merchantId page. Registered after the literal
  // `/flywheel-share` + `.csv` paths so Hono's matcher resolves
  // static > dynamic correctly.
  app.get(
    '/api/admin/merchants/:merchantId/flywheel-stats',
    rateLimit(120, 60_000),
    adminMerchantFlywheelStatsHandler,
  );
  // Per-merchant cashback-summary (#625) — per-currency lifetime
  // user_cashback_minor on fulfilled orders. Sibling of the per-user
  // variant; drives the "cashback paid out" card on the merchant
  // drill-down. Registered after the literal `/flywheel-share` +
  // `.csv` paths so Hono resolves static > dynamic.
  app.get(
    '/api/admin/merchants/:merchantId/cashback-summary',
    rateLimit(120, 60_000),
    adminMerchantCashbackSummaryHandler,
  );
  // Per-merchant payment-method share (#627) — rail mix on one
  // merchant. Sibling of `/api/admin/orders/payment-method-share`,
  // scoped via WHERE merchant_id = :merchantId. Drives a small
  // "rail mix" card on the merchant drill alongside flywheel +
  // cashback-paid. Default ?state=fulfilled, zero-filled across
  // every known payment method for stable layout.
  app.get(
    '/api/admin/merchants/:merchantId/payment-method-share',
    rateLimit(120, 60_000),
    adminMerchantPaymentMethodShareHandler,
  );
  // Per-merchant cashback-monthly (#635) — 12-month per-(month,
  // currency) user_cashback_minor emission trend for one merchant.
  // Sibling of /api/admin/cashback-monthly (fleet) and
  // /api/admin/users/:userId/cashback-monthly (#633). Drives the
  // forthcoming `MerchantCashbackMonthlyChart` on the merchant
  // drill alongside the scalar cashback-paid-out card.
  app.get(
    '/api/admin/merchants/:merchantId/cashback-monthly',
    rateLimit(120, 60_000),
    adminMerchantCashbackMonthlyHandler,
  );
  // Per-merchant flywheel-activity time-series (#641) — daily
  // recycled-vs-total fulfilled-order counts. Time-axis companion
  // to the scalar /flywheel-stats endpoint from #623; drives the
  // forthcoming sparkline on /admin/merchants/:merchantId so ops
  // can see whether LOOP-asset adoption at a merchant is rising
  // or plateaued over time.
  app.get(
    '/api/admin/merchants/:merchantId/flywheel-activity',
    rateLimit(120, 60_000),
    adminMerchantFlywheelActivityHandler,
  );
  // Tier-3 CSV export of the same per-merchant flywheel-activity
  // aggregate (#645). Finance / BD runs this when prepping a
  // commercial conversation with a merchant or negotiating
  // cashback-rate changes against observed recycling behaviour.
  // Rate-limited 10/min per ADR 018.
  app.get(
    '/api/admin/merchants/:merchantId/flywheel-activity.csv',
    rateLimit(10, 60_000),
    adminMerchantFlywheelActivityCsvHandler,
  );
  // Per-merchant top-earners leaderboard (#655) — ranked list of
  // users who earned the most cashback at one merchant in the
  // window. Inverse axis of user-cashback-by-merchant (per-user
  // view asks "where did Alice earn?"; this asks "who earns at
  // Amazon?"). Drives a "Top earners" card on the merchant drill
  // so BD/support can target outreach to whales at a specific
  // merchant. Joins against users for email enrichment — admin-
  // gated, so email is fine in the response.
  app.get(
    '/api/admin/merchants/:merchantId/top-earners',
    rateLimit(120, 60_000),
    adminMerchantTopEarnersHandler,
  );
  // Given an order id, return the single pending_payouts row for it.
  // Nested under /orders/:orderId so the UI can link from the order
  // drill-down straight to the payout state without a separate fetch.
  app.get('/api/admin/orders/:orderId/payout', rateLimit(120, 60_000), adminPayoutByOrderHandler);
  // Supplier-spend snapshot (ADR 013 / 015): per-currency aggregate of
  // what Loop paid CTX across fulfilled orders in the window. Admin UI
  // renders this on the treasury page as the "supplier" card next to
  // outstanding liabilities.
  app.get('/api/admin/supplier-spend', rateLimit(60, 60_000), adminSupplierSpendHandler);
  // Supplier-spend activity time-series (ADR 013 / 015) — per-day
  // per-currency wholesale/face/cashback/margin paid to CTX. The
  // time-axis of the supplier-spend snapshot. Together with
  // credit-flow (ledger in) and payouts-activity (chain out) this
  // completes the three treasury-velocity feeds ops watches to
  // know money moved as expected today.
  app.get(
    '/api/admin/supplier-spend/activity',
    rateLimit(60, 60_000),
    adminSupplierSpendActivityHandler,
  );
  // Per-operator supplier-spend (#674) — per-currency aggregate
  // scoped to one CTX operator. Answers "which operator drove the
  // supplier spend?" — the ADR-022 per-operator axis of the fleet-
  // wide supplier-spend. Ops uses this to spot load-balancing
  // drift: one operator suddenly carrying 80% of spend is a
  // scheduler / circuit-breaker signal.
  app.get(
    '/api/admin/operators/:operatorId/supplier-spend',
    rateLimit(120, 60_000),
    adminOperatorSupplierSpendHandler,
  );
  // Per-operator daily activity time-series (ADR 013 / 022) —
  // completes the operator-drill quartet alongside operator-stats
  // (fleet snapshot), operators/latency (fleet percentiles) and
  // operators/:id/supplier-spend (per-operator cost). Answers "is
  // this operator degrading?" — a rising `failed` line or a
  // dropping fulfilled/created ratio is a scheduler-tuning /
  // CTX-escalation signal before the circuit breaker trips.
  app.get(
    '/api/admin/operators/:operatorId/activity',
    rateLimit(120, 60_000),
    adminOperatorActivityHandler,
  );
  // Per-operator merchant mix (ADR 013 / 022) — dual of the
  // /merchants/:id/operator-mix endpoint. Answers "which merchants
  // is THIS operator carrying?" for CTX relationship capacity
  // reviews ("op-alpha is pulling 40% of its volume from a single
  // merchant — concentration-risk or SLA lever?").
  app.get(
    '/api/admin/operators/:operatorId/merchant-mix',
    rateLimit(120, 60_000),
    adminOperatorMerchantMixHandler,
  );
  // Per-operator breakdown of which CTX service account carried which
  // orders (ADR 013). Complements supplier-spend: spend is *what* Loop
  // paid CTX per currency, operator-stats is *which operator* carried
  // the traffic — the two answer different questions during an
  // incident so they live side-by-side on the treasury page.
  app.get('/api/admin/operator-stats', rateLimit(60, 60_000), adminOperatorStatsHandler);
  // Per-operator fulfilment latency (ADR 013 / 022): p50/p95/p99 of
  // `fulfilledAt - paidAt` per operator in the window. Operator-stats
  // above tells ops *which* operator is busy; this tells them *which
  // is slow*. A busy operator with rising p95 is the early signal
  // before the circuit breaker trips.
  app.get('/api/admin/operators/latency', rateLimit(60, 60_000), adminOperatorLatencyHandler);
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
  // Paginated user directory — browse + search for the admin panel.
  // Complements the exact-by-id drill at /api/admin/users/:userId.
  app.get('/api/admin/users', rateLimit(60, 60_000), adminListUsersHandler);
  // Exact-match email lookup — support pastes the full address from a
  // ticket, gets the user id back in one request. Different lookup
  // mode from the fragment search above; registered before
  // /:userId so the literal 'by-email' segment isn't captured as a
  // uuid param.
  app.get('/api/admin/users/by-email', rateLimit(60, 60_000), adminUserByEmailHandler);
  // Ops funding prioritisation — "who's owed the most USDLOOP right
  // now?". Grouped by (user, asset) over pending + submitted payout
  // rows; complements /api/admin/top-users (which ranks by lifetime
  // earnings). Registered before /:userId so the literal
  // 'top-by-pending-payout' segment isn't treated as a uuid param.
  app.get(
    '/api/admin/users/top-by-pending-payout',
    rateLimit(60, 60_000),
    adminTopUsersByPendingPayoutHandler,
  );
  // "Who's recycling right now?" — 90-day list of users with at least
  // one loop_asset order, ranked by most-recent recycle. Complement to
  // /top-users (by cashback earned) and /top-by-pending-payout (by
  // backlog). Registered before /:userId so the literal segment is
  // not captured as a uuid.
  app.get(
    '/api/admin/users/recycling-activity',
    rateLimit(60, 60_000),
    adminUsersRecyclingActivityHandler,
  );
  // Tier-3 CSV snapshot of the user recycling leaderboard —
  // finance-grade export for ops. Registered before /:userId (same
  // literal-vs-uuid routing constraint as the JSON sibling) and
  // follows the ADR-018 CSV conventions (10/min rate limit, 10k row
  // cap with `__TRUNCATED__` sentinel, attachment disposition).
  app.get(
    '/api/admin/users/recycling-activity.csv',
    rateLimit(10, 60_000),
    adminUsersRecyclingActivityCsvHandler,
  );
  // Admin user-detail drill. Entry point for the admin panel's user
  // page — subsequent drills (credits, credit-transactions, orders)
  // all key off the id this endpoint returns.
  app.get('/api/admin/users/:userId', rateLimit(120, 60_000), adminGetUserHandler);
  // Per-user credit-balance drill-down (ADR 009). Ops opens this from
  // a support ticket; complements the treasury aggregate which only
  // gives fleet-wide outstanding.
  app.get('/api/admin/users/:userId/credits', rateLimit(120, 60_000), adminUserCreditsHandler);
  // Per-user cashback-by-merchant breakdown — support triage. Answers
  // "user asks why they haven't earned cashback on merchant X" by
  // grouping their cashback ledger rows by source-order merchant.
  // Default window 180d, cap 366d; default limit 25, cap 100.
  app.get(
    '/api/admin/users/:userId/cashback-by-merchant',
    rateLimit(120, 60_000),
    adminUserCashbackByMerchantHandler,
  );
  // Scalar cashback headline for a user — mirrors the user-facing
  // /api/users/me/cashback-summary but admin-scoped to any userId.
  // Powers the "£42 lifetime · £3.20 this month" chip on the admin
  // user drill-down. Single query; 404 when the user id doesn't
  // exist (LEFT JOIN returns no rows in that case).
  app.get(
    '/api/admin/users/:userId/cashback-summary',
    rateLimit(120, 60_000),
    adminUserCashbackSummaryHandler,
  );
  // Per-user flywheel scalar — admin mirror of /api/users/me/flywheel-
  // stats. Supports triage questions like "is this user part of the
  // recycling loop or just top-ups?". Single LEFT JOIN; 404 on unknown
  // userId, zero counts on an existing user with no fulfilled orders.
  app.get(
    '/api/admin/users/:userId/flywheel-stats',
    rateLimit(120, 60_000),
    adminUserFlywheelStatsHandler,
  );
  // Per-user payment-method share (#628 follow-up) — user-scoped
  // rail-mix mirror of the fleet + per-merchant siblings. Drives a
  // "rail mix" card on the user drill alongside the flywheel chip
  // + cashback-summary. Same zero-fill + state-default conventions
  // as the other share endpoints.
  app.get(
    '/api/admin/users/:userId/payment-method-share',
    rateLimit(120, 60_000),
    adminUserPaymentMethodShareHandler,
  );
  // Per-user cashback-monthly (#633) — 12-month emission trend for
  // one user. Sibling of /api/admin/cashback-monthly and
  // /api/users/me/cashback-monthly. Drives the forthcoming
  // `UserCashbackMonthlyChart` on the user drill — same visual
  // primitives as the fleet chart, scoped to one user. 404 on
  // unknown userId; zero entries for an existing user with no
  // cashback in the window.
  app.get(
    '/api/admin/users/:userId/cashback-monthly',
    rateLimit(120, 60_000),
    adminUserCashbackMonthlyHandler,
  );
  // Credit-transaction log for a user (ADR 009). Drill-down from the
  // balance endpoint — shows how the balance got there (cashback,
  // withdrawals, refunds, adjustments).
  app.get(
    '/api/admin/users/:userId/credit-transactions',
    rateLimit(120, 60_000),
    adminUserCreditTransactionsHandler,
  );
  // Per-user × per-operator attribution (ADR 013 / 022). Completes
  // the mix-axis matrix: merchant×operator + operator×merchant
  // (existing) plus user×operator here. Support-triage view: "user
  // X complains about slow cashback — which CTX operator has been
  // carrying their recent orders?"
  app.get(
    '/api/admin/users/:userId/operator-mix',
    rateLimit(120, 60_000),
    adminUserOperatorMixHandler,
  );
  // Finance / compliance / support CSV of one user's credit-ledger
  // history. Same Tier-3 rate-limit cadence as the other CSV
  // exports — runs at ticket-resolution speed, not on-click from
  // the admin UI.
  app.get(
    '/api/admin/users/:userId/credit-transactions.csv',
    rateLimit(10, 60_000),
    adminUserCreditTransactionsCsvHandler,
  );
  // Credit-adjustment write (ADR 017). Lower rate limit than reads —
  // it's an explicit ops action, not a polled surface. Idempotency-Key
  // header required; missing header is a 400 at the handler edge.
  app.post(
    '/api/admin/users/:userId/credit-adjustments',
    rateLimit(20, 60_000),
    adminCreditAdjustmentHandler,
  );
  // Refund write (A2-901 + ADR 017). Separate surface from credit-
  // adjustment because refund semantics are positive-only and bind to
  // an order id, with DB-level dupe rejection via the partial unique
  // index on (type, reference_type, reference_id) from migration 0013.
  // Same rate limit and idempotency discipline as the adjustment
  // write.
  app.post('/api/admin/users/:userId/refunds', rateLimit(20, 60_000), adminRefundHandler);
  // ADR-024 / A2-901 — admin-mediated withdrawal: debit user's
  // cashback balance + queue an on-chain LOOP-asset payout. Same
  // rate limit + idempotency discipline as refund.
  app.post(
    '/api/admin/users/:userId/withdrawals',
    killSwitch('withdrawals'),
    rateLimit(20, 60_000),
    adminWithdrawalHandler,
  );
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
