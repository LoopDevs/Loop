# Phase 05 - Backend Request Lifecycle

Status: in-progress

Execution timestamp: `2026-05-03T19:08:00Z`

Baseline commit: `13522bb4ee8279336fb143c5c0f33bbbf6ef205b`

Required evidence:

- route map: captured
- middleware order review: started
- rate limit map: captured; cross-route interference reproduced
- CORS/header/body-limit/request-ID/logging review: started
- upstream validation and circuit-breaker review: pending
- OpenAPI/error envelope reconciliation: pending

Artifacts:

- `artifacts/app.ts.snapshot`
- `artifacts/middleware-files.txt`
- `artifacts/route-files.txt`
- `artifacts/backend-route-registration-lines.txt`
- `artifacts/rate-limit-lines.txt`
- `artifacts/rate-limit-cross-route-repro.txt`
- `artifacts/route-shadow-lines.txt`
- `artifacts/route-shadow-scan.tsv`
- `artifacts/hono-param-literal-order-repro.txt`
- `artifacts/backend-fetch-lines.txt`
- `artifacts/backend-validation-lines.txt`
- `artifacts/upstream-circuit-lines.txt`
- `artifacts/error-envelope-lines.txt`
- `artifacts/metrics-colon-route-repro.txt`

Command/reproduction results:

- App assembly review confirmed global middleware order: optional Sentry, CORS, secure headers, 1 MiB body limit, request ID, AsyncLocalStorage request context, access log, request counter, observability routes, test-only routes in `NODE_ENV=test`, health, then mounted API route modules.
- CORS production allowlist is centralized in `middleware/cors.ts`.
- Body limit returns a consistent `{ code, message }` 413 envelope.
- Rate limiter uses `clientIpFor(c)` as the sole key for every mounted limiter; reproduced that five successful `GET /api/config` requests cause the first `POST /api/auth/request-otp` request to return `429 RATE_LIMITED`.
- Hono parameter/literal route behavior reproduced: parameter routes registered first capture later literal siblings. Current registration shadows `GET /api/orders/loop` and `GET /api/admin/payouts/settlement-lag`; filed `A4-010`.
- Request metrics keying uses colon-delimited strings while route patterns contain colon parameters; reproduced corrupted `/metrics` labels for `/api/merchants/:id`; filed `A4-011`.

Review dimensions:

- Logic correctness: rate-limit isolation bug filed as `A4-009`; route-shadowing bug filed as `A4-010`; parameter-route metrics bug filed as `A4-011`; other middleware still under review.
- Code quality: route-module split is readable and app assembly is centralized.
- Security and privacy: abuse controls can deny unrelated routes for a shared IP because per-route budgets are not isolated.
- Documentation accuracy: pending reconciliation against docs and OpenAPI.
- Test coverage and accuracy: existing rate-limit tests do not appear to cover cross-route budget isolation; deeper test audit continues in Phase 18.
- Planned-feature fit: pending Phase 24.

Findings:

- `A4-009`
- `A4-010`
- `A4-011`
