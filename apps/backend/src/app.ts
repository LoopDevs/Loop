import { Hono } from 'hono';
import type { Context } from 'hono';
import { requestId } from 'hono/request-id';
import { sentry, captureException } from '@sentry/hono/node';
import { scrubSentryEvent } from './sentry-scrubber.js';
import { env } from './env.js';
import { logger } from './logger.js';
import type { User } from './db/users.js';
import { accessLogMiddleware } from './middleware/access-log.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { requestCounterMiddleware } from './middleware/request-counter.js';
import { corsMiddleware } from './middleware/cors.js';
import { secureHeadersMiddleware } from './middleware/secure-headers.js';
import { bodyLimitMiddleware } from './middleware/body-limit.js';
import { killSwitch } from './middleware/kill-switch.js';
import {
  rateLimit,
  __resetRateLimitsForTests as resetRateLimitMap,
} from './middleware/rate-limit.js';
import { startCleanupInterval } from './cleanup.js';
import { metricsHandler, openApiHandler } from './observability-handlers.js';
import {
  merchantListHandler,
  merchantAllHandler,
  merchantBySlugHandler,
  merchantCashbackRateHandler,
  merchantDetailHandler,
  merchantsCashbackRatesHandler,
} from './merchants/handler.js';
import {
  requestOtpHandler,
  verifyOtpHandler,
  refreshHandler,
  logoutHandler,
  requireAuth,
} from './auth/handler.js';
import { createOrderHandler, listOrdersHandler, getOrderHandler } from './orders/handler.js';
import {
  loopCreateOrderHandler,
  loopGetOrderHandler,
  loopListOrdersHandler,
} from './orders/loop-handler.js';
import { mountMiscRoutes } from './routes/misc.js';
import { googleSocialLoginHandler, appleSocialLoginHandler } from './auth/social.js';
import { notifyAdminBulkRead } from './discord.js';
import { requireAdmin } from './auth/require-admin.js';
import { listConfigsHandler, upsertConfigHandler, configHistoryHandler } from './admin/handler.js';
import { adminConfigsHistoryHandler } from './admin/configs-history.js';
import { treasuryHandler } from './admin/treasury.js';
import { adminTreasurySnapshotCsvHandler } from './admin/treasury-snapshot-csv.js';
import { adminTreasuryCreditFlowHandler } from './admin/treasury-credit-flow.js';
import { adminAssetCirculationHandler } from './admin/asset-circulation.js';
import { adminAssetDriftStateHandler } from './admin/asset-drift-state.js';
import {
  adminGetPayoutHandler,
  adminListPayoutsHandler,
  adminPayoutByOrderHandler,
  adminRetryPayoutHandler,
} from './admin/payouts.js';
import { adminPayoutsCsvHandler } from './admin/payouts-csv.js';
import { adminPayoutCompensationHandler } from './admin/payout-compensation.js';
import { adminPayoutsByAssetHandler } from './admin/payouts-by-asset.js';
import { adminSettlementLagHandler } from './admin/settlement-lag.js';
import { adminTopUsersHandler } from './admin/top-users.js';
import { adminTopUsersByPendingPayoutHandler } from './admin/top-users-by-pending-payout.js';
import { adminUsersRecyclingActivityHandler } from './admin/users-recycling-activity.js';
import { adminUsersRecyclingActivityCsvHandler } from './admin/users-recycling-activity-csv.js';
import { adminAuditTailHandler } from './admin/audit-tail.js';
import { adminAuditTailCsvHandler } from './admin/audit-tail-csv.js';
import { adminGetOrderHandler, adminListOrdersHandler } from './admin/orders.js';
import { adminMerchantFlowsHandler } from './admin/merchant-flows.js';
import { adminDiscordConfigHandler } from './admin/discord-config.js';
import { adminUserSearchHandler } from './admin/user-search.js';
import { adminUserCreditsCsvHandler } from './admin/user-credits-csv.js';
import { adminReconciliationHandler } from './admin/reconciliation.js';
import { adminOrdersActivityHandler } from './admin/orders-activity.js';
import { adminPaymentMethodShareHandler } from './admin/payment-method-share.js';
import { adminPaymentMethodActivityHandler } from './admin/payment-method-activity.js';
import { adminOrdersCsvHandler } from './admin/orders-csv.js';
import { adminStuckOrdersHandler } from './admin/stuck-orders.js';
import { adminStuckPayoutsHandler } from './admin/stuck-payouts.js';
import { adminCashbackActivityHandler } from './admin/cashback-activity.js';
import { adminCashbackActivityCsvHandler } from './admin/cashback-activity-csv.js';
import { adminCashbackRealizationHandler } from './admin/cashback-realization.js';
import { adminCashbackRealizationDailyHandler } from './admin/cashback-realization-daily.js';
import { adminCashbackRealizationDailyCsvHandler } from './admin/cashback-realization-daily-csv.js';
import { adminCashbackMonthlyHandler } from './admin/cashback-monthly.js';
import { adminPayoutsMonthlyHandler } from './admin/payouts-monthly.js';
import { adminPayoutsActivityHandler } from './admin/payouts-activity.js';
import { adminPayoutsActivityCsvHandler } from './admin/payouts-activity-csv.js';
import { adminSupplierSpendActivityCsvHandler } from './admin/supplier-spend-activity-csv.js';
import { adminOperatorsSnapshotCsvHandler } from './admin/operators-snapshot-csv.js';
import { adminTreasuryCreditFlowCsvHandler } from './admin/treasury-credit-flow-csv.js';
import { adminMerchantStatsHandler } from './admin/merchant-stats.js';
import { adminMerchantStatsCsvHandler } from './admin/merchant-stats-csv.js';
import { adminMerchantsFlywheelShareHandler } from './admin/merchants-flywheel-share.js';
import { adminMerchantsFlywheelShareCsvHandler } from './admin/merchants-flywheel-share-csv.js';
import { adminMerchantFlywheelStatsHandler } from './admin/merchant-flywheel-stats.js';
import { adminMerchantCashbackSummaryHandler } from './admin/merchant-cashback-summary.js';
import { adminMerchantPaymentMethodShareHandler } from './admin/merchant-payment-method-share.js';
import { adminMerchantCashbackMonthlyHandler } from './admin/merchant-cashback-monthly.js';
import { adminMerchantFlywheelActivityHandler } from './admin/merchant-flywheel-activity.js';
import { adminMerchantFlywheelActivityCsvHandler } from './admin/merchant-flywheel-activity-csv.js';
import { adminMerchantTopEarnersHandler } from './admin/merchant-top-earners.js';
import { adminCashbackConfigsCsvHandler } from './admin/cashback-configs-csv.js';
import { adminMerchantsCatalogCsvHandler } from './admin/merchants-catalog-csv.js';
import { adminSupplierSpendHandler } from './admin/supplier-spend.js';
import { adminSupplierSpendActivityHandler } from './admin/supplier-spend-activity.js';
import { adminOperatorSupplierSpendHandler } from './admin/operator-supplier-spend.js';
import { adminOperatorActivityHandler } from './admin/operator-activity.js';
import { adminOperatorStatsHandler } from './admin/operator-stats.js';
import { adminOperatorLatencyHandler } from './admin/operator-latency.js';
import { adminMerchantOperatorMixHandler } from './admin/merchant-operator-mix.js';
import { adminOperatorMerchantMixHandler } from './admin/operator-merchant-mix.js';
import { adminUserOperatorMixHandler } from './admin/user-operator-mix.js';
import { adminUserCreditsHandler } from './admin/user-credits.js';
import { adminUserCreditTransactionsHandler } from './admin/user-credit-transactions.js';
import { adminUserCreditTransactionsCsvHandler } from './admin/user-credit-transactions-csv.js';
import { adminUserCashbackByMerchantHandler } from './admin/user-cashback-by-merchant.js';
import { adminUserCashbackSummaryHandler } from './admin/user-cashback-summary.js';
import { adminUserFlywheelStatsHandler } from './admin/user-flywheel-stats.js';
import { adminUserPaymentMethodShareHandler } from './admin/user-payment-method-share.js';
import { adminUserCashbackMonthlyHandler } from './admin/user-cashback-monthly.js';
import { adminGetUserHandler } from './admin/user-detail.js';
import { adminUserByEmailHandler } from './admin/user-by-email.js';
import { adminListUsersHandler } from './admin/users-list.js';
import { adminMerchantsResyncHandler } from './admin/merchants-resync.js';
import { adminDiscordNotifiersHandler } from './admin/discord-notifiers.js';
import { adminDiscordTestHandler } from './admin/discord-test.js';
import { adminCreditAdjustmentHandler } from './admin/credit-adjustments.js';
import { adminRefundHandler } from './admin/refunds.js';
import { adminWithdrawalHandler } from './admin/withdrawals.js';
import { mountPublicRoutes } from './routes/public.js';
import {
  dsrDeleteHandler,
  dsrExportHandler,
  getCashbackHistoryHandler,
  getCashbackHistoryCsvHandler,
  getCashbackSummaryHandler,
  getMeHandler,
  getUserCreditsHandler,
  getUserPayoutByOrderHandler,
  getUserPendingPayoutDetailHandler,
  getUserPendingPayoutsHandler,
  getUserPendingPayoutsSummaryHandler,
  setHomeCurrencyHandler,
  setStellarAddressHandler,
} from './users/handler.js';
import { getUserStellarTrustlinesHandler } from './users/stellar-trustlines.js';
import { getCashbackByMerchantHandler } from './users/cashback-by-merchant.js';
import { getCashbackMonthlyHandler } from './users/cashback-monthly.js';
import { getUserOrdersSummaryHandler } from './users/orders-summary.js';
import { getUserFlywheelStatsHandler } from './users/flywheel-stats.js';
import { getUserPaymentMethodShareHandler } from './users/payment-method-share.js';

export const app = new Hono();

// Sentry middleware — captures request context, performance, and errors
if (env.SENTRY_DSN) {
  app.use(
    sentry(app, {
      dsn: env.SENTRY_DSN,
      // A2-1310: `LOOP_ENV` is the explicit logical-env tag so a
      // staging deploy that sets `NODE_ENV=production` can still
      // bucket events as `staging`. Falls back to NODE_ENV so
      // existing prod + dev deploys are unaffected.
      environment: env.LOOP_ENV ?? env.NODE_ENV,
      // A2-1309: release tag pivots a Sentry event back to the
      // deploy artifact. CI/CD sets `SENTRY_RELEASE` to the git SHA.
      // Absent → Sentry omits the attribute (pre-launch default; dev
      // runs don't poison the release pivot).
      ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
      // A2-1308: scrub known-secret keys out of every captured event
      // before it leaves the process. Sentry's sendDefaultPii:false
      // default handles the well-known PII fields; this catches the
      // Loop-specific secrets (env-named signing keys, CTX API
      // credentials, DATABASE_URL, Discord webhooks) that would
      // otherwise land in `extra` / `contexts` / `request.headers`.
      beforeSend: (event) => scrubSentryEvent(event),
    }),
  );
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
//
// `rateLimit`, `clientIpFor`, the `rateLimitMap` cap, and the test
// reset helper all live in `./middleware/rate-limit.ts` so the
// limiter has a single home that owns its module-local state.
// `clientIpFor` and `__resetRateLimitsForTests` are re-exported here
// so existing test imports (`trust-proxy.test.ts`,
// `routes.integration.test.ts`, etc.) keep working without
// re-targeting in this PR.
export { clientIpFor, __resetRateLimitsForTests } from './middleware/rate-limit.js';

// Health-handler test seams live in `./health.ts` alongside the
// state they reset. Re-exported here so existing test imports
// (`routes.integration.test.ts` etc.) keep working.
export {
  __resetHealthProbeCacheForTests,
  __resetUpstreamProbeCacheOnlyForTests,
} from './health.js';
import {
  healthHandler,
  __resetUpstreamProbeCacheOnlyForTests as resetUpstreamProbeCacheOnly,
} from './health.js';

// (rate-limit body extracted to ./middleware/rate-limit.ts above)

// `killSwitch` factory (A2-1907) lives in `./middleware/kill-switch.ts`.

// ─── Global middleware ────────────────────────────────────────────────────────

// CORS — `PRODUCTION_ORIGINS` allowlist + middleware factory live
// in `./middleware/cors.ts` (audit A-…/A2-1009 — the source of
// truth for which origins can hit the prod API).
app.use('*', corsMiddleware);
// `secureHeaders` (CSP + cross-origin policy) lives in
// `./middleware/secure-headers.ts`. `bodyLimit` (1 MiB cap with the
// 413 PAYLOAD_TOO_LARGE envelope from A2-1005) lives in
// `./middleware/body-limit.ts`.
app.use('*', secureHeadersMiddleware);
app.use('*', bodyLimitMiddleware);
app.use('*', requestId());
// A2-1305 AsyncLocalStorage request-context wrapper lives in
// `./middleware/request-context.ts`. Must come after Hono's
// `requestId()` (the wrapper reads `c.get('requestId')`) and
// before the access logger (the log line reads its `requestId`
// from the ALS-populated context).
app.use('*', requestContextMiddleware);

// Pino-backed access logger (audit A-021) lives in
// `./middleware/access-log.ts`. The mount has to come AFTER
// `requestId()` so the context var the middleware reads is
// populated by the time the log line is written.
app.use('*', accessLogMiddleware);

// ─── Metrics ─────────────────────────────────────────────────────────────────
//
// `Metrics` interface, the `metrics` singleton, and the
// `incrementRateLimitHit` / `incrementRequest` mutators all live in
// `./metrics.ts` so the rate-limit middleware (below) and the
// `/metrics` Prometheus emitter (lower in this file) can both reach
// the same singleton without one of them being the carrier module.

// Request counter middleware (audit A-022 cardinality cap) lives
// in `./middleware/request-counter.ts`. Runs after the handler so
// it observes the final status; collapses unmatched routes to
// `NOT_FOUND` so a URL fuzz can't balloon Prometheus series.
app.use('*', requestCounterMiddleware);

// `/metrics` (Prometheus exposition) + `/openapi.json` (static
// spec) handlers live in `./observability-handlers.ts`. Both are
// gated by `probeGateAllows` (closed-by-default in production
// unless `*_BEARER_TOKEN` env var is set).
app.get('/metrics', metricsHandler);
app.get('/openapi.json', openApiHandler);

// ─── Test-only reset endpoint ─────────────────────────────────────────────────
//
// Mocked e2e tests run against this process as a long-lived server (each
// test spawns a fresh browser context but hits the same backend). Per-IP
// rate-limit state accumulates across tests — a single IP exercising
// `/api/auth/request-otp` across multiple tests + Playwright retries will
// blow through the 5/min budget and start seeing 429, which manifests as
// a disabled Continue button that never re-enables (the UI sees it as a
// network error and leaves auth-loading stuck in its cleanup path).
//
// Expose a reset hook for the mocked suite's `beforeEach` to call. Gated
// on `NODE_ENV=test` so production can't be nudged into dropping the
// limiter. The unit-test rate-limit coverage (see
// `routes.integration.test.ts`) imports `__resetRateLimitsForTests`
// directly and isn't affected by this endpoint.
if (env.NODE_ENV === 'test') {
  // Deliberately outside the `/api` namespace so it doesn't appear in
  // the OpenAPI spec and the lint-docs "route must be in architecture.md"
  // check leaves it alone.
  app.post('/__test__/reset', (c) => {
    resetRateLimitMap();
    resetUpstreamProbeCacheOnly();
    return c.json({ message: 'reset' });
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────
//
// `/health` handler + the rolling-window flap-damping state +
// the upstream-probe cache + the Discord notify cooldown all live
// in `./health.ts`. The handler is mounted here so the route
// table stays in app.ts.
app.get('/health', healthHandler);

// `/api/clusters` + `/api/config` + `/api/image` (the three
// single-mount routes that don't fit a larger namespace) live in
// `./routes/misc.ts`.
mountMiscRoutes(app);

// ─── Merchants ────────────────────────────────────────────────────────────────

// A2-650: the list + by-slug + /all reads were previously unlimited —
// a crawler or misbehaved client could burst them without ever hitting
// a 429. Per-IP limits sized for realistic browse patterns:
//   - /api/merchants is paginated (page + limit + optional ?q=) and
//     fires on filter/page-change, so 180/min comfortably covers a
//     fast typist + rapid pagination.
//   - /api/merchants/all returns the full catalog in one shot; legitimate
//     clients fetch it once and cache. 60/min is more than enough.
//   - /api/merchants/by-slug/:slug drives the SEO landing pages via the
//     web bundle; 120/min matches the sibling cashback-rate endpoints.
// Matches the shape of /api/merchants/cashback-rates (120/min) and
// /api/merchants/:id/cashback-rate (120/min) which were rate-limited
// already.
app.get('/api/merchants', rateLimit(180, 60_000), merchantListHandler);
// /all must come before /:id so that 'all' is not interpreted as an id.
app.get('/api/merchants/all', rateLimit(60, 60_000), merchantAllHandler);
app.get('/api/merchants/by-slug/:slug', rateLimit(120, 60_000), merchantBySlugHandler); // must be before /:id
// GET /api/merchants/cashback-rates — bulk map of active cashback
// pcts across every merchant (ADR 011 / 015). Lets catalog / list /
// map views render "X% cashback" badges without N+1-ing the
// per-merchant endpoint. Static literal path — must come BEFORE the
// `/:merchantId/cashback-rate` route so Hono's router matches the
// literal instead of treating "cashback-rates" as a path param.
app.get('/api/merchants/cashback-rates', rateLimit(120, 60_000), merchantsCashbackRatesHandler);
// GET /api/merchants/:merchantId/cashback-rate — public cashback-rate
// preview for rendering "Earn X% cashback" on the gift-card detail page
// (ADR 011 / 015). Registered BEFORE the requireAuth gate on /:id so
// the checkout page can query it without a bearer. Own rate limit
// since the gift-card detail page fires it alongside the merchant
// detail fetch; 120/min per IP matches the other merchant reads.
app.get(
  '/api/merchants/:merchantId/cashback-rate',
  rateLimit(120, 60_000),
  merchantCashbackRateHandler,
);
// Authenticated — the handler calls CTX /merchants/:id with the user's
// bearer + X-Client-Id to enrich the cached merchant with long-form
// content (description / longDescription / terms / instructions).
// Unauthed callers still see the basic cached merchant via by-slug.
app.use('/api/merchants/:id', requireAuth);
// A2-1008: the single authed merchant-detail route was the only authed
// GET with no rate limit. The handler fires a CTX upstream fetch on
// every call — a runaway client (or a compromised bearer driving the
// endpoint in a loop) would pin an upstream circuit + burn CTX quota
// without any local backpressure. 120/min per IP matches the other
// merchant reads and is well above a logged-in user's realistic
// browse rate.
app.get('/api/merchants/:id', rateLimit(120, 60_000), merchantDetailHandler);

// `/api/public/*` route mounts (ADR 020 — unauthenticated,
// never-500, CDN-friendly) live in `./routes/public.ts`. Mount
// site stays here so the route-table view in app.ts surfaces
// where the public surface lands in the middleware chain.
mountPublicRoutes(app);

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Auth responses carry access + refresh tokens. POST/DELETE aren't cached
// by standards-compliant caches, but a misconfigured intermediate proxy
// that treats any HTTP response as cacheable would otherwise hand one
// user's freshly-minted tokens to the next caller of the same URL. Same
// defense-in-depth pattern used for /api/orders.
app.use('/api/auth/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

app.post('/api/auth/request-otp', killSwitch('auth'), rateLimit(5, 60_000), requestOtpHandler);
// OTP brute-force defense: 10 attempts per minute per IP. With a 6-digit code
// that caps guesses at ~14,400/day — upstream lockout/expiry happens first.
app.post('/api/auth/verify-otp', killSwitch('auth'), rateLimit(10, 60_000), verifyOtpHandler);
// Refresh abuse defense: legit clients refresh once per access-token lifetime,
// so 30/min per IP leaves plenty of headroom without enabling spray attacks.
app.post('/api/auth/refresh', rateLimit(30, 60_000), refreshHandler);
// Social login (ADR 014). Same 10/min cap as verify-otp — both
// are unauthenticated entry points and both resolve to a minted
// Loop JWT pair on success.
app.post(
  '/api/auth/social/google',
  killSwitch('auth'),
  rateLimit(10, 60_000),
  googleSocialLoginHandler,
);
app.post(
  '/api/auth/social/apple',
  killSwitch('auth'),
  rateLimit(10, 60_000),
  appleSocialLoginHandler,
);
// Logout: 20/min per IP. The handler fans out to an upstream revoke, so
// without a limit an attacker could cheaply spam arbitrary refresh tokens
// at CTX through us.
app.delete('/api/auth/session', rateLimit(20, 60_000), logoutHandler);

// ─── Orders (authenticated) ───────────────────────────────────────────────────
//
// Per-IP rate limits here are defense in depth beyond requireAuth: a
// compromised or leaked bearer token would otherwise let the attacker
// hammer us — creating billable orders upstream (POST), or spamming
// CTX with list/read traffic (GET). Budgets are tuned against legit
// usage:
//   - POST: a user rarely creates more than one order per minute;
//     10/min leaves room for retry-after-error without enabling abuse.
//   - GET /api/orders: the Orders page navigates; 60/min is generous.
//   - GET /api/orders/:id: PaymentStep polls every 3s (~20/min);
//     120/min accommodates multiple pending orders and a retry burst.

// Force Cache-Control: private, no-store on every response under
// /api/orders — these contain a specific user's purchase history and
// gift-card redemption payloads. Without this, a CDN or intermediate
// proxy keyed on URL alone (not Authorization) could cache one user's
// `GET /api/orders` response and serve it to another user's next
// request. Fly.io itself doesn't proxy-cache, but this removes the
// footgun before any future edge caching is introduced.
//
// Registered BEFORE requireAuth so the header still applies on the
// 401 response requireAuth emits when no Bearer is present — a
// misbehaving CDN that caches 401s wouldn't then leak the "this URL
// needs auth" shape across requests.
app.use('/api/orders', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.use('/api/orders/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

app.use('/api/orders', requireAuth);
app.use('/api/orders/*', requireAuth);

app.post('/api/orders', killSwitch('orders'), rateLimit(10, 60_000), createOrderHandler);
app.get('/api/orders', rateLimit(60, 60_000), listOrdersHandler);
app.get('/api/orders/:id', rateLimit(120, 60_000), getOrderHandler);
// Loop-native order creation (ADR 010). Lives at a distinct path so
// the legacy CTX-proxy flow at POST /api/orders stays live during
// the migration window. Gated inside the handler on
// LOOP_AUTH_NATIVE_ENABLED — off → 404.
app.post('/api/orders/loop', killSwitch('orders'), rateLimit(10, 60_000), loopCreateOrderHandler);
// Loop-native orders list (ADR 010). Listed before :id so the path
// param doesn't capture 'list' or similar; rate 60/min matches the
// legacy /api/orders GET.
app.get('/api/orders/loop', rateLimit(60, 60_000), loopListOrdersHandler);
// Loop-native order GET. The UI polls this while an order is
// pending_payment → paid → procuring → fulfilled, so the rate is
// generous. Owner-scoped: the handler 404s on a non-owner read so
// existence isn't leaked.
app.get('/api/orders/loop/:id', rateLimit(120, 60_000), loopGetOrderHandler);

// ─── User profile ───────────────────────────────────────────────────────────
//
// `GET /api/users/me` returns the caller's profile: id, email, admin
// flag, and home_currency (ADR 015). Works against both Loop-native
// and legacy CTX bearers — CTX bearers upsert the Loop user row on
// first touch, Loop bearers resolve by userId.
// A2-1002: cache header mw registered BEFORE requireAuth so a 401
// from missing/invalid Bearer still gets `Cache-Control: private,
// no-store`. Without this ordering, a misbehaving CDN that caches
// 401s could leak the "this URL needs auth" shape across users.
// Mirrors the /api/orders ordering documented above.
app.use('/api/users/me', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.use('/api/users/me/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});
app.use('/api/users/me', requireAuth);
app.use('/api/users/me/*', requireAuth);
app.get('/api/users/me', rateLimit(60, 60_000), getMeHandler);
// POST /api/users/me/home-currency — onboarding-time picker (ADR 015).
// Rate limit lower than GET: users only hit this during signup, so 10/min
// is plenty of headroom for a double-tap retry without enabling enumeration.
app.post('/api/users/me/home-currency', rateLimit(10, 60_000), setHomeCurrencyHandler);
// PUT /api/users/me/stellar-address — opt in / out of on-chain cashback
// payouts by linking a Stellar address (ADR 015). Null body unlinks.
// Rate-limited same cadence as other profile writes — a user changing
// wallets is a low-volume action, 10/min is plenty without enabling
// enumeration.
app.put('/api/users/me/stellar-address', rateLimit(10, 60_000), setStellarAddressHandler);
// A2-1906: GET /api/users/me/dsr/export — self-serve data export
// (GDPR right to portability / CCPA equivalent the privacy policy
// promises). 5/hour per IP — the export is a non-trivial multi-table
// scan, but a legitimate user testing their export shouldn't hit a
// wall on a couple of dry-runs. Each request also writes an
// info-level log line tagged `area: 'dsr-export'` for the operator
// audit trail.
app.get('/api/users/me/dsr/export', rateLimit(5, 60 * 60_000), dsrExportHandler);
// A2-1905: POST /api/users/me/dsr/delete — self-serve account
// anonymisation (DSR / GDPR right of erasure the privacy policy
// promises). Anonymisation rather than hard delete because ADR-009
// makes the credit ledger append-only — see `dsr-delete.ts` module
// header for the full posture. 3/hour per IP — destructive, but
// must allow legitimate retries on transient 5xx without locking the
// user out of their own deletion.
app.post('/api/users/me/dsr/delete', rateLimit(3, 60 * 60_000), dsrDeleteHandler);
// GET /api/users/me/stellar-trustlines — per-LOOP-asset trustline
// status for the caller's linked address (ADR 015). Horizon-backed,
// 30s cache per-address. Powers the /settings/wallet "can I receive
// USDLOOP cashback?" affordance before the payout worker discovers
// a missing trustline via a failed submit.
app.get('/api/users/me/stellar-trustlines', rateLimit(30, 60_000), getUserStellarTrustlinesHandler);
// GET /api/users/me/cashback-history — paginated credit-ledger events for
// the caller (ADR 009 / 015). 60/min matches the profile GET cadence; the
// Account page loads it alongside /me on mount, and TanStack Query invalidates
// it after any ledger-touching admin action (support edits, payouts).
app.get('/api/users/me/cashback-history', rateLimit(60, 60_000), getCashbackHistoryHandler);
// Full credit-ledger CSV dump for the caller (ADR 009). Tighter rate
// limit than the JSON sibling because the query is unbounded in size.
app.get('/api/users/me/cashback-history.csv', rateLimit(6, 60_000), getCashbackHistoryCsvHandler);
// GET /api/users/me/credits — caller's off-chain cashback balance per
// currency (ADR 009 / 015). /me surfaces a single scalar in the user's
// home currency; this is the multi-currency complement for users who
// have flipped home currency or received a non-home adjustment.
app.get('/api/users/me/credits', rateLimit(60, 60_000), getUserCreditsHandler);
// GET /api/users/me/pending-payouts — caller-scoped on-chain payout
// rows (ADR 015 / 016). 60/min matches the history endpoint; clients
// typically poll this from /settings/cashback while a payout is in
// flight. State + before + limit query shape mirrors the admin endpoint.
app.get('/api/users/me/pending-payouts', rateLimit(60, 60_000), getUserPendingPayoutsHandler);
// GET /api/users/me/pending-payouts/summary — aggregate view of the
// caller's in-flight payouts, bucketed by (asset, state). One round
// trip replaces paging the full list when a UI only needs the "you
// have $X cashback settling" signal (client-homepage chip etc).
app.get(
  '/api/users/me/pending-payouts/summary',
  rateLimit(60, 60_000),
  getUserPendingPayoutsSummaryHandler,
);
// GET /api/users/me/pending-payouts/:id — caller-scoped single
// drill-down. Cross-user access returns 404 (not 403) so payout
// ids aren't enumerable.
app.get(
  '/api/users/me/pending-payouts/:id',
  rateLimit(120, 60_000),
  getUserPendingPayoutDetailHandler,
);
// GET /api/users/me/orders/:orderId/payout — for one of the
// caller's own orders, return the single pending-payout row tied
// to it. Mirror of the admin /api/admin/orders/:orderId/payout
// but ownership-scoped. Powers a per-order settlement card on
// /orders/:id — users see their Stellar-side cashback state
// ("submitted / confirmed / failed") without scrolling payouts.
app.get(
  '/api/users/me/orders/:orderId/payout',
  rateLimit(120, 60_000),
  getUserPayoutByOrderHandler,
);
// GET /api/users/me/cashback-summary — compact lifetime + this-month
// cashback totals in the user's home currency. Powers the home-page
// headline ("£42 earned · £3.20 this month") without paging the
// whole credit_transactions ledger.
app.get('/api/users/me/cashback-summary', rateLimit(60, 60_000), getCashbackSummaryHandler);
// GET /api/users/me/cashback-by-merchant — user's top cashback-earning
// merchants in a rolling window. Powers the "earned by merchant" card
// on /settings/cashback so users see which merchants drive their
// cashback accrual without scrolling the full ledger (ADR 009/015).
app.get('/api/users/me/cashback-by-merchant', rateLimit(60, 60_000), getCashbackByMerchantHandler);
// Last-12-months cashback totals for the caller, grouped by (month,
// currency). Drives the monthly bar chart on /settings/cashback —
// answers "how did this month compare to last?" without hitting the
// full ledger endpoint on the client (ADR 009/015).
app.get('/api/users/me/cashback-monthly', rateLimit(60, 60_000), getCashbackMonthlyHandler);
// 5-number summary header for /orders: total, fulfilled, pending,
// failed, lifetime spend. Companion to /cashback-summary; single
// query with FILTER-ed COUNT/SUM so the /orders page doesn't hit
// the list endpoint just to render a header (ADR 010).
app.get('/api/users/me/orders/summary', rateLimit(60, 60_000), getUserOrdersSummaryHandler);
// Personal flywheel stats — how many of the caller's fulfilled
// orders they paid for with LOOP asset (recycled cashback), vs
// the total fulfilled denominator. Powers a motivational chip on
// /orders: "You've recycled £X of cashback across Y orders". User-
// side mirror of /api/admin/orders/payment-method-share. One query.
app.get('/api/users/me/flywheel-stats', rateLimit(60, 60_000), getUserFlywheelStatsHandler);
// User-facing rail mix (#643) — self-view of the caller's own
// orders-by-payment-method, home-currency locked. Drives a
// forthcoming "your rail mix" card on /settings/cashback so
// users can see their own LOOP-asset share and the app can
// nudge toward LOOP for compounding cashback. Same zero-fill +
// default ?state=fulfilled as the admin siblings.
app.get(
  '/api/users/me/payment-method-share',
  rateLimit(60, 60_000),
  getUserPaymentMethodShareHandler,
);

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
app.use('/api/admin/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

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
app.get('/api/admin/merchants-catalog.csv', rateLimit(10, 60_000), adminMerchantsCatalogCsvHandler);
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
// Pending-payouts backlog list (ADR 015). Admin UI's "payouts" page
// drills into pending/submitted/confirmed/failed rows; counts for the
// at-a-glance card come from the treasury snapshot above.
app.get('/api/admin/payouts', rateLimit(60, 60_000), adminListPayoutsHandler);
// GET /api/admin/payouts/:id — single-row drill-down (permalink for
// an ops ticket / incident note). Higher rate limit than the list
// because the admin UI deep-links individual rows on every navigation.
app.get('/api/admin/payouts/:id', rateLimit(120, 60_000), adminGetPayoutHandler);
// Per-asset payout breakdown — crosses asset_code × state for the
// LOOP stablecoin triage view (ADR 015/016). Admin UI renders this
// on the treasury page as a per-asset table next to the flat payout
// list, so an incident in one asset doesn't get lost in the volume
// of another.
app.get('/api/admin/payouts-by-asset', rateLimit(60, 60_000), adminPayoutsByAssetHandler);
// Settlement-lag SLA — p50/p95/max seconds from pending_payouts row
// insert to on-chain confirmation, windowed. One row per LOOP asset
// plus a fleet-wide aggregate (`assetCode: null`). The SLA signal
// operators watch alongside drift: if payouts are taking hours, the
// drift number will grow regardless of minting health.
app.get('/api/admin/payouts/settlement-lag', rateLimit(60, 60_000), adminSettlementLagHandler);
// POST /api/admin/payouts/:id/retry — flip a failed row back to pending.
// Lower rate limit: retries should be rare, one-at-a-time ops actions.
app.post('/api/admin/payouts/:id/retry', rateLimit(20, 60_000), adminRetryPayoutHandler);
// POST /api/admin/payouts/:id/compensate — re-credit a user after a
// permanently-failed withdrawal payout (ADR-024 §5). Same rate limit
// as retry: rare, finance-reviewed, one-at-a-time.
app.post(
  '/api/admin/payouts/:id/compensate',
  killSwitch('withdrawals'),
  rateLimit(20, 60_000),
  adminPayoutCompensationHandler,
);
// Finance-ready CSV export of pending_payouts rows. Lower rate
// limit than the JSON list because exports scan rows 500× the
// size of a pagination fetch.
app.get('/api/admin/payouts.csv', rateLimit(10, 60_000), adminPayoutsCsvHandler);
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
app.get('/api/admin/cashback-realization', rateLimit(60, 60_000), adminCashbackRealizationHandler);
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
app.get('/api/admin/cashback-activity.csv', rateLimit(10, 60_000), adminCashbackActivityCsvHandler);
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

// ─── 404 fallback ────────────────────────────────────────────────────────────

// Return our consistent JSON error shape for unmatched routes instead of
// Hono's default text 404 so clients can parse errors uniformly.
app.notFound((c) => {
  return c.json({ code: 'NOT_FOUND', message: 'Route not found' }, 404);
});

// ─── Error handler ───────────────────────────────────────────────────────────

// Catch-all error handler — explicitly capture to Sentry + return clean JSON.
// Includes the request ID so clients can report specific failures without us
// having to cross-reference Sentry timestamps.
app.onError((err, c) => {
  captureException(err);
  const requestId = c.get('requestId') ?? c.req.header('X-Request-Id');
  return c.json(
    { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    500,
  );
});

// ─── Periodic cleanup ────────────────────────────────────────────────────────
//
// Hourly sweep of expired image-cache blobs, rate-limit windows,
// and idempotency snapshots lives in `./cleanup.ts`. We start the
// interval here at module-init time and re-export
// `stopCleanupInterval` so `index.ts` can call it from its
// graceful-shutdown handler.
startCleanupInterval();
export { stopCleanupInterval } from './cleanup.js';
