import { Hono } from 'hono';
import { sentry, captureException } from '@sentry/hono/node';
import { env } from './env.js';
import { accessLogMiddleware } from './middleware/access-log.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { requestCounterMiddleware } from './middleware/request-counter.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { corsMiddleware } from './middleware/cors.js';
import { secureHeadersMiddleware } from './middleware/secure-headers.js';
import { bodyLimitMiddleware } from './middleware/body-limit.js';
import { startCleanupInterval } from './cleanup.js';
import { metricsHandler, openApiHandler } from './observability-handlers.js';
import { mountTestEndpoints } from './test-endpoints.js';
import { mountMerchantRoutes } from './routes/merchants.js';
import { mountAuthRoutes } from './routes/auth.js';
import { mountOrderRoutes } from './routes/orders.js';
import { mountMiscRoutes } from './routes/misc.js';
import { mountPublicRoutes } from './routes/public.js';
import { mountUserRoutes } from './routes/users.js';
import { mountAdminRoutes } from './routes/admin.js';

export const app = new Hono();

// Sentry middleware — captures request context, performance, and errors.
// Init lives in `./instrument.ts` (loaded via Node `--import` per
// @sentry/hono 10.51 split-init pattern); this just attaches the
// per-request middleware. Gated on `SENTRY_DSN` so dev runs without
// the env var don't pay the middleware cost.
if (env.SENTRY_DSN) {
  app.use(sentry(app));
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
import { healthHandler } from './health.js';

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
// A4-008: server-mints the request id and ignores any inbound
// X-Request-Id header. Hono's stock `requestId()` honours the
// client-supplied value when it matches a permissive shape, which
// lets a client pollute access logs / Sentry breadcrumbs /
// upstream CTX correlation with a chosen string or impersonate a
// victim's correlation id. The custom wrapper always generates a
// fresh UUID server-side and writes it to the response header.
app.use('*', requestIdMiddleware);
// A2-1305 AsyncLocalStorage request-context wrapper lives in
// `./middleware/request-context.ts`. Must come after the
// request-id middleware (the wrapper reads `c.get('requestId')`)
// and before the access logger (the log line reads its
// `requestId` from the ALS-populated context).
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
// `/__test__/reset` (mocked-e2e harness rate-limit + probe-cache
// reset hook) lives in `./test-endpoints.ts`. Gated on
// `NODE_ENV=test` here so production can't mount it.
if (env.NODE_ENV === 'test') {
  mountTestEndpoints(app);
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

// `/api/merchants/*` route mounts (catalog reads + auth-gated
// detail fetch) live in `./routes/merchants.ts`. Mount-order
// constraints (literals before parameterised paths;
// `requireAuth` on `/:id` before the `/:id` GET) live in the
// new module's @file jsdoc so the rationale stays next to the
// code that depends on it.
mountMerchantRoutes(app);

// `/api/public/*` route mounts (ADR 020 — unauthenticated,
// never-500, CDN-friendly) live in `./routes/public.ts`. Mount
// site stays here so the route-table view in app.ts surfaces
// where the public surface lands in the middleware chain.
mountPublicRoutes(app);

// `/api/auth/*` route mounts (OTP / refresh / social / logout +
// the no-store cache-control mount that gates them all) live in
// `./routes/auth.ts`. Bundled together because the cache-control
// constraint is inseparable from the credential-minting handlers.
mountAuthRoutes(app);

// `/api/orders/*` route mounts (legacy CTX-proxy + Loop-native
// paths) live in `./routes/orders.ts`. Bundles cache-control +
// requireAuth + handlers together because the mount-order
// constraint between them (cache-control before auth so 401s
// also get `private, no-store`) is the contract.
mountOrderRoutes(app);

// ─── User profile ───────────────────────────────────────────────────────────
//
// `/api/users/me/*` route mounts (profile + DSR + cashback +
// payouts + flywheel — ~17 endpoints) live in `./routes/users.ts`.
// Bundles cache-control + requireAuth + handlers because the
// mount-order constraint between them (cache-control before auth
// so 401s also get `private, no-store`) is the contract.
mountUserRoutes(app);

// `/api/admin/*` route mounts (the entire admin panel — ~80
// endpoints) live in `./routes/admin.ts`. Bundles cache-control
// + requireAuth + requireAdmin + Discord-bulk-notify together
// because their mount-order discipline is the contract.
mountAdminRoutes(app);

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
  // A4-008: use the server-minted requestId from the context; the
  // requestIdMiddleware in middleware/request-id.ts always sets it
  // before routes run. The inbound-header fallback was dropped to
  // close the log-poisoning sidechannel.
  const requestId = (c as unknown as { get(key: 'requestId'): string | undefined }).get(
    'requestId',
  );
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
