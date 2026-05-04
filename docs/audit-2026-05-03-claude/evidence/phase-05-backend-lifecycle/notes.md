# Phase 05 - Backend Request Lifecycle

Status: complete (pending Phase 25 synthesis)
Owner: lead (Claude)
Reviewer: lead (Claude)

## Files reviewed (primary)

- `apps/backend/src/app.ts`
- `apps/backend/src/middleware/{cors,secure-headers,body-limit,rate-limit,access-log,kill-switch,cache-control,request-context,request-counter,probe-gate}.ts`
- `apps/backend/src/circuit-breaker.ts`, `circuit-breaker-registry.ts`
- `apps/backend/src/health.ts`, `index.ts`, `cleanup.ts`
- `apps/backend/src/upstream.ts`, `upstream-body-scrub.ts`
- `apps/backend/src/routes/{public,merchants,auth,orders,users,admin,misc}.ts`
- `apps/backend/src/__tests__/{routes.integration,trust-proxy,trust-proxy-trusted}.test.ts`

## Middleware chain (verified)

1. `sentry(app)` — gated on `SENTRY_DSN`
2. `corsMiddleware` — `*` outside production; `PRODUCTION_ORIGINS` in production
3. `secureHeadersMiddleware` — strict CSP, frame-ancestors none
4. `bodyLimitMiddleware` — 1 MiB cap, 413 envelope
5. Hono `requestId()` — accepts inbound `X-Request-Id` by default (A4-008)
6. `requestContextMiddleware` — AsyncLocalStorage wrap
7. `accessLogMiddleware` — Pino, skips successful probes
8. `requestCounterMiddleware` — Prometheus counter
9. Route mounts with per-route rate limits and per-namespace cache/auth chains
10. `app.notFound` and `app.onError` JSON envelopes

## Findings filed

- A4-001 High — per-IP rate-limit bucket shared across all routes
- A4-008 Low — `X-Request-Id` header trusted from client input by default
- A4-013 Info — docs vs. code rate-limit drift

## Cross-file interactions

- `requestId()` writes `c.get('requestId')` consumed by access logger, circuit breaker outbound propagation.
- CORS allowlist is the single source of truth for `loopfinance.io`, `www.loopfinance.io`, and Capacitor scheme origins.
- Per-endpoint circuit breakers (login, verify-email, refresh-token, logout, merchants, locations, gift-cards) instantiated lazily via `getUpstreamCircuit(name)`.
- Kill-switch reads `process.env` directly at call time for hot-flip via Fly secrets.

## Outputs

- Findings register entries A4-001, A4-008, A4-013.
- File disposition register updated for `app.ts` and `middleware/**` files (reviewed-with-finding).
- Cross-references to phases 06 (auth handler interaction), 17 (security), 19 (logger/probe), 20 (CI/health checks).
