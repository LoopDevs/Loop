/**
 * `/api/admin/users*` route mounts — the user-cluster
 * (ADR 009 / 015 / 022).
 *
 * Lifted out of `apps/backend/src/routes/admin.ts`. 13 routes that
 * back the admin user directory + per-user drill page. Mirrors the
 * openapi/admin-user-cluster.ts split (#1176) for the six
 * directory/lookup/credit reads, plus the per-user-drill axes that
 * live in `./openapi/admin-per-user-drill.ts` (#1168), the
 * `users/:userId/operator-mix` from `./openapi/admin-operator-mix.ts`
 * (#1171), and the recycling-activity pair that travels here on the
 * routes side because of mount-block contiguity.
 *
 * Routes:
 *   - GET /api/admin/users                              (paginated directory)
 *   - GET /api/admin/users/by-email                     (literal lookup)
 *   - GET /api/admin/users/top-by-pending-payout        (literal leaderboard)
 *   - GET /api/admin/users/recycling-activity (+ .csv)  (literal flywheel feed)
 *   - GET /api/admin/users/:userId                      (single drill)
 *   - GET /api/admin/users/:userId/credits
 *   - GET /api/admin/users/:userId/cashback-by-merchant
 *   - GET /api/admin/users/:userId/cashback-summary
 *   - GET /api/admin/users/:userId/flywheel-stats
 *   - GET /api/admin/users/:userId/payment-method-share
 *   - GET /api/admin/users/:userId/cashback-monthly
 *   - GET /api/admin/users/:userId/credit-transactions (+ .csv)
 *   - GET /api/admin/users/:userId/operator-mix
 *
 * Mount-order discipline preserved verbatim — the literal
 * `/users/by-email`, `/users/top-by-pending-payout`,
 * `/users/recycling-activity`, `/users/recycling-activity.csv`
 * paths register BEFORE `/users/:userId` so Hono\'s URL-template
 * tree resolves static > dynamic correctly.
 *
 * Mount-order semantics shared with `mountAdminRoutes`: this
 * factory MUST be called AFTER the 4-piece middleware stack
 * (cache-control / requireAuth / requireAdmin / audit middleware)
 * is in place; that\'s the parent factory\'s responsibility.
 */
import type { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { adminListUsersHandler } from '../admin/users-list.js';
import { adminUserByEmailHandler } from '../admin/user-by-email.js';
import { adminGetUserHandler } from '../admin/user-detail.js';
import { adminTopUsersByPendingPayoutHandler } from '../admin/top-users-by-pending-payout.js';
import { adminUsersRecyclingActivityHandler } from '../admin/users-recycling-activity.js';
import { adminUsersRecyclingActivityCsvHandler } from '../admin/users-recycling-activity-csv.js';
import { adminUserCreditsHandler } from '../admin/user-credits.js';
import { adminUserCashbackByMerchantHandler } from '../admin/user-cashback-by-merchant.js';
import { adminUserCashbackSummaryHandler } from '../admin/user-cashback-summary.js';
import { adminUserFlywheelStatsHandler } from '../admin/user-flywheel-stats.js';
import { adminUserPaymentMethodShareHandler } from '../admin/user-payment-method-share.js';
import { adminUserCashbackMonthlyHandler } from '../admin/user-cashback-monthly.js';
import { adminUserCreditTransactionsHandler } from '../admin/user-credit-transactions.js';
import { adminUserCreditTransactionsCsvHandler } from '../admin/user-credit-transactions-csv.js';
import { adminUserOperatorMixHandler } from '../admin/user-operator-mix.js';

/**
 * Mounts the user-cluster routes on the supplied Hono app. Called
 * once from `mountAdminRoutes` after the admin middleware stack is
 * in place.
 */
export function mountAdminUserClusterRoutes(app: Hono): void {
  // Paginated user directory — browse + search for the admin panel.
  // Complements the exact-by-id drill at /api/admin/users/:userId.
  app.get('/api/admin/users', rateLimit('GET /api/admin/users', 60, 60_000), adminListUsersHandler);
  // Exact-match email lookup — support pastes the full address from a
  // ticket, gets the user id back in one request. Different lookup
  // mode from the fragment search above; registered before
  // /:userId so the literal 'by-email' segment isn't captured as a
  // uuid param.
  app.get(
    '/api/admin/users/by-email',
    rateLimit('GET /api/admin/users/by-email', 60, 60_000),
    adminUserByEmailHandler,
  );
  // Ops funding prioritisation — "who's owed the most USDLOOP right
  // now?". Grouped by (user, asset) over pending + submitted payout
  // rows; complements /api/admin/top-users (which ranks by lifetime
  // earnings). Registered before /:userId so the literal
  // 'top-by-pending-payout' segment isn't treated as a uuid param.
  app.get(
    '/api/admin/users/top-by-pending-payout',
    rateLimit('GET /api/admin/users/top-by-pending-payout', 60, 60_000),
    adminTopUsersByPendingPayoutHandler,
  );
  // "Who's recycling right now?" — 90-day list of users with at least
  // one loop_asset order, ranked by most-recent recycle. Complement to
  // /top-users (by cashback earned) and /top-by-pending-payout (by
  // backlog). Registered before /:userId so the literal segment is
  // not captured as a uuid.
  app.get(
    '/api/admin/users/recycling-activity',
    rateLimit('GET /api/admin/users/recycling-activity', 60, 60_000),
    adminUsersRecyclingActivityHandler,
  );
  // Tier-3 CSV snapshot of the user recycling leaderboard —
  // finance-grade export for ops. Registered before /:userId (same
  // literal-vs-uuid routing constraint as the JSON sibling) and
  // follows the ADR-018 CSV conventions (10/min rate limit, 10k row
  // cap with `__TRUNCATED__` sentinel, attachment disposition).
  app.get(
    '/api/admin/users/recycling-activity.csv',
    rateLimit('GET /api/admin/users/recycling-activity.csv', 10, 60_000),
    adminUsersRecyclingActivityCsvHandler,
  );
  // Admin user-detail drill. Entry point for the admin panel's user
  // page — subsequent drills (credits, credit-transactions, orders)
  // all key off the id this endpoint returns.
  app.get(
    '/api/admin/users/:userId',
    rateLimit('GET /api/admin/users/:userId', 120, 60_000),
    adminGetUserHandler,
  );
  // Per-user credit-balance drill-down (ADR 009). Ops opens this from
  // a support ticket; complements the treasury aggregate which only
  // gives fleet-wide outstanding.
  app.get(
    '/api/admin/users/:userId/credits',
    rateLimit('GET /api/admin/users/:userId/credits', 120, 60_000),
    adminUserCreditsHandler,
  );
  // Per-user cashback-by-merchant breakdown — support triage. Answers
  // "user asks why they haven't earned cashback on merchant X" by
  // grouping their cashback ledger rows by source-order merchant.
  // Default window 180d, cap 366d; default limit 25, cap 100.
  app.get(
    '/api/admin/users/:userId/cashback-by-merchant',
    rateLimit('GET /api/admin/users/:userId/cashback-by-merchant', 120, 60_000),
    adminUserCashbackByMerchantHandler,
  );
  // Scalar cashback headline for a user — mirrors the user-facing
  // /api/users/me/cashback-summary but admin-scoped to any userId.
  // Powers the "£42 lifetime · £3.20 this month" chip on the admin
  // user drill-down. Single query; 404 when the user id doesn't
  // exist (LEFT JOIN returns no rows in that case).
  app.get(
    '/api/admin/users/:userId/cashback-summary',
    rateLimit('GET /api/admin/users/:userId/cashback-summary', 120, 60_000),
    adminUserCashbackSummaryHandler,
  );
  // Per-user flywheel scalar — admin mirror of /api/users/me/flywheel-
  // stats. Supports triage questions like "is this user part of the
  // recycling loop or just top-ups?". Single LEFT JOIN; 404 on unknown
  // userId, zero counts on an existing user with no fulfilled orders.
  app.get(
    '/api/admin/users/:userId/flywheel-stats',
    rateLimit('GET /api/admin/users/:userId/flywheel-stats', 120, 60_000),
    adminUserFlywheelStatsHandler,
  );
  // Per-user payment-method share (#628 follow-up) — user-scoped
  // rail-mix mirror of the fleet + per-merchant siblings. Drives a
  // "rail mix" card on the user drill alongside the flywheel chip
  // + cashback-summary. Same zero-fill + state-default conventions
  // as the other share endpoints.
  app.get(
    '/api/admin/users/:userId/payment-method-share',
    rateLimit('GET /api/admin/users/:userId/payment-method-share', 120, 60_000),
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
    rateLimit('GET /api/admin/users/:userId/cashback-monthly', 120, 60_000),
    adminUserCashbackMonthlyHandler,
  );
  // Credit-transaction log for a user (ADR 009). Drill-down from the
  // balance endpoint — shows how the balance got there (cashback,
  // withdrawals, refunds, adjustments).
  app.get(
    '/api/admin/users/:userId/credit-transactions',
    rateLimit('GET /api/admin/users/:userId/credit-transactions', 120, 60_000),
    adminUserCreditTransactionsHandler,
  );
  // Per-user × per-operator attribution (ADR 013 / 022). Completes
  // the mix-axis matrix: merchant×operator + operator×merchant
  // (existing) plus user×operator here. Support-triage view: "user
  // X complains about slow cashback — which CTX operator has been
  // carrying their recent orders?"
  app.get(
    '/api/admin/users/:userId/operator-mix',
    rateLimit('GET /api/admin/users/:userId/operator-mix', 120, 60_000),
    adminUserOperatorMixHandler,
  );
  // Finance / compliance / support CSV of one user's credit-ledger
  // history. Same Tier-3 rate-limit cadence as the other CSV
  // exports — runs at ticket-resolution speed, not on-click from
  // the admin UI.
  app.get(
    '/api/admin/users/:userId/credit-transactions.csv',
    rateLimit('GET /api/admin/users/:userId/credit-transactions.csv', 10, 60_000),
    adminUserCreditTransactionsCsvHandler,
  );
}
