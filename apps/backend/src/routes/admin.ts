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
import { sanitizeAdminReadQueryString } from '../admin/read-audit.js';
import { privateNoStoreResponse } from '../middleware/cache-control.js';
import { requireAuth } from '../auth/handler.js';
import { requireAdmin } from '../auth/require-admin.js';
import { notifyAdminBulkRead } from '../discord.js';
import { mountAdminCashbackConfigRoutes } from './admin-cashback-config.js';
import { mountAdminCreditWritesRoutes } from './admin-credit-writes.js';
import { mountAdminUserWritesRoutes } from './admin-user-writes.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminStepUpHandler } from '../admin/step-up-handler.js';
import { mountAdminDashboardRoutes } from './admin-dashboard.js';
import { mountAdminFleetMonthlyRoutes } from './admin-fleet-monthly.js';
import { mountAdminOperatorRoutes } from './admin-operator.js';
import { mountAdminOpsTailRoutes } from './admin-ops-tail.js';
import { mountAdminOrderDrillRoutes } from './admin-order-drill.js';
import { mountAdminPayoutsRoutes } from './admin-payouts.js';
import { mountAdminPerMerchantRoutes } from './admin-per-merchant.js';
import { mountAdminTreasuryRoutes } from './admin-treasury.js';
import { mountAdminUserClusterRoutes } from './admin-user-cluster.js';

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
    const query = sanitizeAdminReadQueryString(c.req.url.split('?')[1] ?? '');
    const isCsv = path.endsWith('.csv');

    logger.info(
      {
        area: 'admin-read-audit',
        actorUserId: actor.id,
        method: c.req.method,
        path,
        query: query !== undefined ? query.slice(0, 200) : undefined,
        isBulk: isCsv,
      },
      'Admin read',
    );

    if (isCsv) {
      notifyAdminBulkRead({
        actorUserId: actor.id,
        endpoint: `${c.req.method} ${path}`,
        ...(query !== undefined ? { queryString: query } : {}),
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

  // Ops-tail residual — orders list, merchant-flows, discord/*,
  // users/search, user-credits.csv, reconciliation, merchant-stats,
  // orders/:orderId/payout, top-users, audit-tail (+ .csv),
  // merchants/resync. Lifted into ./admin-ops-tail.ts (mirrors openapi
  // #1169 misc-reads + #1180 ops-tail). Mount-order: must precede
  // mountAdminUserClusterRoutes so /users/search literal registers
  // before /users/:userId param.
  mountAdminOpsTailRoutes(app);

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

  // (ADR 011/013/015/018/022). Lifted into ./admin-per-merchant.ts.
  // Mount-order: literal /flywheel-share + .csv before the
  // /:merchantId/* family.
  mountAdminPerMerchantRoutes(app);

  // per-operator supplier-spend / activity / merchant-mix, fleet
  // operator-stats + operators/latency. Lifted into ./admin-operator.ts
  // (mirrors openapi #1172 + #1173).
  mountAdminOperatorRoutes(app);

  // (ADR 009/015/022). Lifted into ./admin-user-cluster.ts (mirrors
  // openapi #1176 + the per-user-drill axes from #1168 / #1171).
  // Mount-order: literal lookup paths register before /:userId.
  mountAdminUserClusterRoutes(app);

  // Credit-write surfaces — credit-adjustments + refunds +
  // withdrawals (ADR 017/024 + A2-901). Lifted into
  // ./admin-credit-writes.ts (mirrors openapi #1175).
  mountAdminCreditWritesRoutes(app);

  // Admin user-property writes — currently just the home-currency
  // flip (ADR 015 deferred § "self-serve home-currency change —
  // currently support-mediated"). Same step-up + idempotency
  // discipline as the credit writes; lives in its own file because
  // it isn't a credit/refund/withdrawal.
  mountAdminUserWritesRoutes(app);

  // ADR-028 / A4-063: step-up token endpoint. Mounted under the
  // standard admin middleware stack (cache-control / requireAuth /
  // requireAdmin / audit) so only authenticated admins can mint
  // step-up tokens — but NOT under requireAdminStepUp itself
  // (chicken-and-egg: the admin can't have a step-up token before
  // they hit this endpoint to get one).
  app.post(
    '/api/admin/step-up',
    rateLimit('POST /api/admin/step-up', 30, 60_000),
    adminStepUpHandler,
  );
}
