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
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import { requireAdmin } from '../auth/require-admin.js';
import { notifyAdminBulkRead } from '../discord.js';
import { mountAdminCashbackConfigRoutes } from './admin-cashback-config.js';
import { mountAdminTreasuryRoutes } from './admin-treasury.js';
import { adminPayoutByOrderHandler } from '../admin/payouts.js';
import { mountAdminPayoutsRoutes } from './admin-payouts.js';
import { adminTopUsersHandler } from '../admin/top-users.js';
import { adminTopUsersByPendingPayoutHandler } from '../admin/top-users-by-pending-payout.js';
import { adminUsersRecyclingActivityHandler } from '../admin/users-recycling-activity.js';
import { adminUsersRecyclingActivityCsvHandler } from '../admin/users-recycling-activity-csv.js';
import { adminAuditTailHandler } from '../admin/audit-tail.js';
import { adminAuditTailCsvHandler } from '../admin/audit-tail-csv.js';
import { adminListOrdersHandler } from '../admin/orders.js';
import { adminMerchantFlowsHandler } from '../admin/merchant-flows.js';
import { adminDiscordConfigHandler } from '../admin/discord-config.js';
import { adminUserSearchHandler } from '../admin/user-search.js';
import { adminUserCreditsCsvHandler } from '../admin/user-credits-csv.js';
import { adminReconciliationHandler } from '../admin/reconciliation.js';
import { mountAdminOrderDrillRoutes } from './admin-order-drill.js';
import { mountAdminDashboardRoutes } from './admin-dashboard.js';
import { mountAdminFleetMonthlyRoutes } from './admin-fleet-monthly.js';
import { adminMerchantStatsHandler } from '../admin/merchant-stats.js';
import { mountAdminPerMerchantRoutes } from './admin-per-merchant.js';
import { mountAdminOperatorRoutes } from './admin-operator.js';
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
import { mountAdminCreditWritesRoutes } from './admin-credit-writes.js';

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

  // Cashback-config CRUD + merchants-catalog CSV (ADR 011/018).
  // Lifted into ./admin-cashback-config.ts; the sub-factory mounts
  // these 6 routes preserving the literal-vs-param ordering for
  // /:merchantId and /history.
  mountAdminCashbackConfigRoutes(app);

  // Treasury + asset-drift cluster — snapshot + .csv +
  // credit-flow series + per-asset circulation drift + watcher
  // state (ADR 009/015/016/018). Lifted into ./admin-treasury.ts.
  mountAdminTreasuryRoutes(app);

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
  // Order-drill cluster — orders/activity, orders/payment-method-
  // share + activity, orders/:orderId, orders.csv (ADR 010/011/015/019).
  // Lifted into ./admin-order-drill.ts; mount-order discipline preserved
  // (literal-suffix routes register before param-only /:orderId).
  mountAdminOrderDrillRoutes(app);

  // Dashboard cluster — stuck-orders / stuck-payouts /
  // cashback-activity (+ .csv) / cashback-realization (+ /daily +
  // /daily.csv) — the operational + flywheel signals on /admin.
  // Lifted into ./admin-dashboard.ts (mirrors openapi #1174).
  mountAdminDashboardRoutes(app);

  // Fleet-monthly + finance-CSV — cashback-monthly +
  // payouts-monthly + payouts-activity (+ .csv) + supplier-spend
  // activity.csv + operators-snapshot.csv + treasury credit-flow
  // .csv. Lifted into ./admin-fleet-monthly.ts (mirrors openapi #1165
  // for the JSON; CSV companions travel alongside their siblings).
  mountAdminFleetMonthlyRoutes(app);

  // Per-merchant cashback stats — which merchants drive volume /
  // cashback outlay / margin. Distinct from supplier-spend (currency
  // grouped) — this one groups by merchant.
  app.get('/api/admin/merchant-stats', rateLimit(60, 60_000), adminMerchantStatsHandler);
  // Per-merchant drill cluster + fleet flywheel-share leaderboard
  // (ADR 011/013/015/018/022). Lifted into ./admin-per-merchant.ts.
  // Mount-order: literal /flywheel-share + .csv before the
  // /:merchantId/* family.
  mountAdminPerMerchantRoutes(app);

  // Given an order id, return the single pending_payouts row for it.
  // Nested under /orders/:orderId so the UI can link from the order
  // drill-down straight to the payout state without a separate fetch.
  app.get('/api/admin/orders/:orderId/payout', rateLimit(120, 60_000), adminPayoutByOrderHandler);
  // Operator + supplier-spend cluster — supplier-spend (+ activity),
  // per-operator supplier-spend / activity / merchant-mix, fleet
  // operator-stats + operators/latency. Lifted into ./admin-operator.ts
  // (mirrors openapi #1172 + #1173).
  mountAdminOperatorRoutes(app);

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
  // Credit-write surfaces — credit-adjustments + refunds +
  // withdrawals (ADR 017/024 + A2-901). Lifted into
  // ./admin-credit-writes.ts (mirrors openapi #1175).
  mountAdminCreditWritesRoutes(app);

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
