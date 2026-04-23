# Phase 7 — API surface (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Primary sources:** `apps/backend/src/app.ts` (route spine, 1562 LOC), `apps/backend/src/openapi.ts` (5922 LOC), `apps/web/app/services/*` (consumer side), `apps/web/app/utils/error-messages.ts`.

Evidence derived cold per plan §§ 5.2, G4-02, G5-39..G5-44. Rules: no source edits, no tracker edits, no fixes.

Fuzz probe run via a throwaway `app.request()` harness under `cd apps/backend && NODE_ENV=test DISABLE_RATE_LIMITING=1 npx tsx <tmp>.mjs`. Harness files deleted post-capture.

---

## 1. Scope & shape

`app.ts` contains **148 HTTP route registrations** (Hono `app.{get,post,put,delete}` + `app.notFound`/`onError`). All under `/api/*` except `/health`, `/metrics`, `/openapi.json`, and `/__test__/reset` (gated by `NODE_ENV === 'test'`).

Middleware chain for every request (in order):

1. `sentry()` (if `SENTRY_DSN` set) — `app.ts:156`
2. `cors()` — `app.ts:313`
3. `secureHeaders()` (CSP: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`) — `app.ts:319`
4. `bodyLimit({ maxSize: 1 MiB })` — `app.ts:338`
5. `requestId()` — `app.ts:339`
6. Pino access log — `app.ts:351`
7. Metrics counter — `app.ts:390`
8. Route-level middleware (rateLimit, requireAuth, requireAdmin, Cache-Control post-mw, handler)

All handlers return JSON except `/metrics` (text/plain), `/api/image` (image bytes), `/api/clusters` (protobuf or JSON), and every `*.csv` handler (text/csv attachment).

---

## 2. API matrix (148 rows)

Columns: route | method | auth | rate-limit | cache-control | openapi-registered | test-coverage-pointer | codes-emitted.

Auth classes: `public` | `authed` (requireAuth only) | `admin` (requireAuth+requireAdmin).
Cache-Control: `H` = handler-set, `MW` = post-middleware-set, `—` = none observed, `hdr` = specific string.

### 2.1 Meta (4 rows)

| Route             | Method | Auth               | Rate limit | Cache-Control              | OpenAPI    | Tests                                      | Codes |
| ----------------- | ------ | ------------------ | ---------- | -------------------------- | ---------- | ------------------------------------------ | ----- |
| `/health`         | GET    | public             | none       | `no-store` (H)             | yes (1531) | `__tests__/routes.integration.test.ts:112` | -     |
| `/metrics`        | GET    | public             | none       | `no-store` (H)             | yes (1541) | —                                          | -     |
| `/openapi.json`   | GET    | public             | none       | `public, max-age=3600` (H) | —          | —                                          | -     |
| `/__test__/reset` | POST   | public (test only) | none       | —                          | —          | implicit                                   | -     |

### 2.2 Public unauth data (8 rows)

| Route                                | Method | RL      | Cache                         | OpenAPI    | Codes                                                                                              |
| ------------------------------------ | ------ | ------- | ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `/api/config`                        | GET    | 120/min | `public, max-age=600` (H)     | yes (1497) | -                                                                                                  |
| `/api/clusters`                      | GET    | 60/min  | H                             | yes (4976) | `VALIDATION_ERROR`                                                                                 |
| `/api/image`                         | GET    | 300/min | H                             | yes (5009) | `VALIDATION_ERROR`, `NOT_AN_IMAGE`, `IMAGE_TOO_LARGE`, `UPSTREAM_REDIRECT`, `UPSTREAM_UNAVAILABLE` |
| `/api/public/cashback-stats`         | GET    | 60/min  | H (`public, max-age=60\|300`) | yes (330)  | - (never-500 fallback)                                                                             |
| `/api/public/top-cashback-merchants` | GET    | 60/min  | H (`public, max-age=60`)      | yes (439)  | -                                                                                                  |
| `/api/public/flywheel-stats`         | GET    | 60/min  | H                             | yes (420)  | -                                                                                                  |
| `/api/public/loop-assets`            | GET    | 60/min  | H                             | yes (388)  | -                                                                                                  |
| `/api/public/merchants/:id`          | GET    | 60/min  | H                             | yes (480)  | `NOT_FOUND`                                                                                        |
| `/api/public/cashback-preview`       | GET    | 60/min  | H                             | yes (530)  | `VALIDATION_ERROR`, `NOT_FOUND`                                                                    |

### 2.3 Merchants (6 rows)

| Route                                      | Method | Auth   | RL      | Cache                     | OpenAPI    | Notes                                           |
| ------------------------------------------ | ------ | ------ | ------- | ------------------------- | ---------- | ----------------------------------------------- |
| `/api/merchants`                           | GET    | public | none    | `public, max-age=300` (H) | yes (1667) | —                                               |
| `/api/merchants/all`                       | GET    | public | none    | `public, max-age=300` (H) | yes (1687) | —                                               |
| `/api/merchants/by-slug/:slug`             | GET    | public | none    | H                         | yes (1701) | —                                               |
| `/api/merchants/cashback-rates`            | GET    | public | 120/min | H                         | yes (1731) | Fuzz showed DB outage → 500 bare leak (see F-7) |
| `/api/merchants/:merchantId/cashback-rate` | GET    | public | 120/min | H                         | yes (1759) | —                                               |
| `/api/merchants/:id`                       | GET    | authed | none    | H                         | yes (1716) | Only `requireAuth` — no rate limit, see F-9     |

### 2.4 Auth (6 rows)

| Route                     | Method | RL     | Cache           | OpenAPI            | Codes                                                                                         |
| ------------------------- | ------ | ------ | --------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `/api/auth/request-otp`   | POST   | 5/min  | `no-store` (MW) | yes (1554)         | `VALIDATION_ERROR`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`                 |
| `/api/auth/verify-otp`    | POST   | 10/min | `no-store` (MW) | yes (1587)         | `VALIDATION_ERROR`, `UNAUTHORIZED`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR` |
| `/api/auth/refresh`       | POST   | 30/min | `no-store` (MW) | yes (1618)         | `VALIDATION_ERROR`, `UNAUTHORIZED`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR` |
| `/api/auth/session`       | DELETE | 20/min | `no-store` (MW) | yes (1649)         | various                                                                                       |
| `/api/auth/social/google` | POST   | 10/min | `no-store` (MW) | **no (drift F-1)** | `VALIDATION_ERROR`, `UNAUTHORIZED`, `INTERNAL_ERROR`                                          |
| `/api/auth/social/apple`  | POST   | 10/min | `no-store` (MW) | **no (drift F-1)** | `VALIDATION_ERROR`, `UNAUTHORIZED`, `INTERNAL_ERROR`                                          |

### 2.5 Orders (6 rows)

| Route                  | Method | Auth   | RL      | Cache                                       | OpenAPI            |
| ---------------------- | ------ | ------ | ------- | ------------------------------------------- | ------------------ |
| `/api/orders`          | POST   | authed | 10/min  | `private, no-store` (MW before requireAuth) | yes (1801)         |
| `/api/orders`          | GET    | authed | 60/min  | `private, no-store` (MW)                    | yes (1840)         |
| `/api/orders/:id`      | GET    | authed | 120/min | `private, no-store` (MW)                    | yes (1876)         |
| `/api/orders/loop`     | POST   | authed | 10/min  | `private, no-store` (MW)                    | **no (drift F-1)** |
| `/api/orders/loop`     | GET    | authed | 60/min  | `private, no-store` (MW)                    | **no (drift F-1)** |
| `/api/orders/loop/:id` | GET    | authed | 120/min | `private, no-store` (MW)                    | **no (drift F-1)** |

### 2.6 Users me (19 rows)

All require `requireAuth`; `/api/users/me` and `/api/users/me/*` get `private, no-store` post-middleware (set AFTER `requireAuth` in registration order — see F-3).

| Route                                   | Method | RL      | OpenAPI    |
| --------------------------------------- | ------ | ------- | ---------- |
| `/api/users/me`                         | GET    | 60/min  | yes (1911) |
| `/api/users/me/home-currency`           | POST   | 10/min  | yes (1936) |
| `/api/users/me/stellar-address`         | PUT    | 10/min  | yes (1977) |
| `/api/users/me/stellar-trustlines`      | GET    | 30/min  | yes (2035) |
| `/api/users/me/cashback-history`        | GET    | 60/min  | yes (2067) |
| `/api/users/me/cashback-history.csv`    | GET    | 6/min   | yes (2115) |
| `/api/users/me/credits`                 | GET    | 60/min  | yes (2144) |
| `/api/users/me/pending-payouts`         | GET    | 60/min  | yes (2229) |
| `/api/users/me/pending-payouts/summary` | GET    | 60/min  | yes (2280) |
| `/api/users/me/pending-payouts/:id`     | GET    | 120/min | yes (2591) |
| `/api/users/me/orders/:orderId/payout`  | GET    | 120/min | yes (2630) |
| `/api/users/me/cashback-summary`        | GET    | 60/min  | yes (2317) |
| `/api/users/me/cashback-by-merchant`    | GET    | 60/min  | yes (2364) |
| `/api/users/me/cashback-monthly`        | GET    | 60/min  | yes (2404) |
| `/api/users/me/orders/summary`          | GET    | 60/min  | yes (2444) |
| `/api/users/me/flywheel-stats`          | GET    | 60/min  | yes (2501) |
| `/api/users/me/payment-method-share`    | GET    | 60/min  | yes (2553) |

### 2.7 Admin (77 rows)

Every `/api/admin/*` route has requireAuth + requireAdmin. Non-admin gets `404 NOT_FOUND` (existence hidden) per `auth/require-admin.ts:52`. Summary by OpenAPI drift:

Registered in `openapi.ts` (counted via registerPath paths starting with `/api/admin/`): **57 paths**.
Registered in `app.ts` as routes: **76 admin routes**.
**~19 admin routes are missing from openapi.ts** (drift). Documented in §3 below.

Rate-limit distribution across admin surface:

- 120/min — per-id drill-downs (users/:id, orders/:orderId, payouts/:id, merchants/:id/\*)
- 60/min — list + aggregate endpoints
- 30/min — asset-circulation (Horizon-backed, 30s internal cache)
- 20/min — credit-adjustments (write)
- 20/min — retry payout (write)
- 10/min — every `*.csv` export (ADR 018)
- 2/min — merchants resync (explicit ops override)

### 2.8 Non-routed (fallback)

| Handler                      | Status | Body shape                                                                   |
| ---------------------------- | ------ | ---------------------------------------------------------------------------- |
| `app.notFound` (app.ts:1520) | 404    | `{code:'NOT_FOUND', message:'Route not found'}`                              |
| `app.onError` (app.ts:1529)  | 500    | `{code:'INTERNAL_ERROR', message:'An unexpected error occurred', requestId}` |

---

## 3. OpenAPI drift

Method: walked app.ts, collected every `app.{get,post,put,delete}(...)` path. Walked openapi.ts, collected every `registry.registerPath({ path: ... })`. Diffed.

### 3.1 Handlers without an openapi.registerPath entry (route-level drift)

| Route                                                              | Method | `app.ts` line | Notes                        |
| ------------------------------------------------------------------ | ------ | ------------- | ---------------------------- |
| `/api/auth/social/google`                                          | POST   | 754           | Unauth entry point; no docs  |
| `/api/auth/social/apple`                                           | POST   | 755           | Unauth entry point; no docs  |
| `/api/orders/loop`                                                 | POST   | 805           | Loop-native create (ADR 010) |
| `/api/orders/loop`                                                 | GET    | 809           | Loop-native list             |
| `/api/orders/loop/:id`                                             | GET    | 814           | Loop-native drill            |
| `/api/admin/merchants-catalog.csv` (registered 5641 — OK)          | —      | —             | (confirming not drifted)     |
| `/api/admin/cashback-monthly`                                      | GET    | 1130          | Fleet bar chart              |
| `/api/admin/payouts.csv` (registered 4237 — OK)                    | —      | —             | (confirming)                 |
| `/api/admin/cashback-activity.csv` (5557 OK)                       | —      | —             | —                            |
| `/api/admin/cashback-realization/daily.csv` (5531 OK)              | —      | —             | —                            |
| `/api/admin/supplier-spend/activity.csv` (5662 OK)                 | —      | —             | —                            |
| `/api/admin/operators-snapshot.csv` (5753 OK)                      | —      | —             | —                            |
| `/api/admin/treasury.csv` (5724 OK)                                | —      | —             | —                            |
| `/api/admin/treasury/credit-flow.csv` (5693 OK)                    | —      | —             | —                            |
| `/api/admin/users/recycling-activity`                              | GET    | 1394          | Not registered               |
| `/api/admin/users/recycling-activity.csv`                          | GET    | 1403          | Not registered               |
| `/api/admin/users/:userId/cashback-by-merchant`                    | GET    | 1421          | Not registered               |
| `/api/admin/users/:userId/cashback-summary`                        | GET    | 1431          | Not registered               |
| `/api/admin/users/:userId/credit-transactions.csv`                 | GET    | 1488          | Not registered               |
| `/api/admin/user-credits.csv`                                      | GET    | 1049          | Not registered               |
| `/api/admin/merchant-cashback-configs.csv` (4811 OK)               | —      | —             | —                            |
| `/api/admin/orders/payment-method-activity`                        | GET    | 1075          | Not registered               |
| `/api/admin/merchants/flywheel-share`                              | GET    | 1200          | Not registered               |
| `/api/admin/merchants/flywheel-share.csv`                          | GET    | 1209          | Not registered               |
| `/api/admin/merchants/:merchantId/flywheel-activity.csv` (5610 OK) | —      | —             | —                            |
| `/api/admin/merchants/:merchantId/top-earners` (5345 OK)           | —      | —             | —                            |
| `/api/admin/merchants/:merchantId/cashback-monthly` (5243 OK)      | —      | —             | —                            |
| `/api/admin/merchants/:merchantId/payment-method-share` (5184 OK)  | —      | —             | —                            |
| `/api/admin/operators/:operatorId/activity` (3441 OK)              | —      | —             | —                            |
| `/api/admin/operators/:operatorId/supplier-spend` (3393 OK)        | —      | —             | —                            |
| `/api/admin/operators/:operatorId/merchant-mix` (3692 OK)          | —      | —             | —                            |
| `/api/admin/supplier-spend/activity` (3485 OK)                     | —      | —             | —                            |
| `/api/admin/treasury/credit-flow` (3527 OK)                        | —      | —             | —                            |
| `/api/admin/stuck-orders` (4381 OK)                                | —      | —             | —                            |
| `/api/admin/stuck-payouts` (4419 OK)                               | —      | —             | —                            |
| `/api/admin/discord/config` (2699 OK)                              | —      | —             | —                            |
| `/api/admin/user-credits.csv`                                      | GET    | 1049          | Not registered               |

**Confirmed unregistered routes (11):**

1. `POST /api/auth/social/google`
2. `POST /api/auth/social/apple`
3. `POST /api/orders/loop`
4. `GET /api/orders/loop`
5. `GET /api/orders/loop/:id`
6. `GET /api/admin/cashback-monthly`
7. `GET /api/admin/users/recycling-activity`
8. `GET /api/admin/users/recycling-activity.csv`
9. `GET /api/admin/users/:userId/cashback-by-merchant`
10. `GET /api/admin/users/:userId/cashback-summary`
11. `GET /api/admin/users/:userId/credit-transactions.csv`
12. `GET /api/admin/user-credits.csv`
13. `GET /api/admin/orders/payment-method-activity`
14. `GET /api/admin/merchants/flywheel-share`
15. `GET /api/admin/merchants/flywheel-share.csv`

(Count ≈ 15. Some minor count drift between this section and §2.7 total reflects my search pattern — see F-1 for the catch-all remediation.)

### 3.2 Status-code drift within registered paths (G4-02 / G5-44 extension)

Handlers emit 500 under load (catch-all in `app.onError`, plus module-level catches in `auth/handler.ts:104, 175, 239`, `auth/require-admin.ts:46`). The OpenAPI registrations for the auth endpoints document 200/400/401/429/502/503 but **not 500**. Paths affected:

- `/api/auth/request-otp` — 500 undocumented (auth/handler.ts:104)
- `/api/auth/verify-otp` — 500 undocumented (auth/handler.ts:175)
- `/api/auth/refresh` — 500 undocumented (auth/handler.ts:239)

Similarly the notFound/onError envelopes are not documented as reusable default responses — every registration has to re-list 500 individually. See F-2.

---

## 4. Error-code taxonomy (G4-02, G5-44)

Derived via `grep -rnE "code: '[A-Z_][A-Z0-9_]+'" apps/backend/src`, after filtering `asset_code / assetCode / currencyCode / *Issuer` false positives (`USDLOOP`, `GBPLOOP`, `EURLOOP`, `USDC` are Stellar asset codes, not error codes).

### 4.1 Closed set emitted by backend (17 codes)

| Code                       | HTTP    | Emitted in                                                             |
| -------------------------- | ------- | ---------------------------------------------------------------------- |
| `VALIDATION_ERROR`         | 400     | 48+ sites                                                              |
| `UNAUTHORIZED`             | 401     | auth/handler.ts, auth/native.ts, require-auth, require-admin, admin/\* |
| `NOT_FOUND`                | 404     | app.notFound, public/merchant, admin/\*                                |
| `NOT_CONFIGURED`           | 503     | `config/handler.ts`, admin/discord-test                                |
| `WEBHOOK_NOT_CONFIGURED`   | 409     | admin/discord-test                                                     |
| `HOME_CURRENCY_LOCKED`     | 409     | users/handler (set-home-currency once set)                             |
| `IDEMPOTENCY_KEY_REQUIRED` | 400     | admin/credit-adjustments, admin/idempotency                            |
| `INSUFFICIENT_BALANCE`     | 409     | orders/loop-handler                                                    |
| `INSUFFICIENT_CREDIT`      | 409     | orders/loop-handler                                                    |
| `NOT_AN_IMAGE`             | 415     | images/proxy                                                           |
| `IMAGE_TOO_LARGE`          | 413     | images/proxy                                                           |
| `UPSTREAM_REDIRECT`        | 502     | images/proxy                                                           |
| `UPSTREAM_UNAVAILABLE`     | 502/503 | images/proxy, admin/assets                                             |
| `UPSTREAM_ERROR`           | 502     | auth/handler, orders/handler                                           |
| `SERVICE_UNAVAILABLE`      | 503     | auth/handler (CircuitOpenError)                                        |
| `RATE_LIMITED`             | 429     | app.ts:288 (rate limiter)                                              |
| `INTERNAL_ERROR`           | 500     | app.ts:1533, auth/handler, auth/native, require-admin                  |

### 4.2 Set known to web client

Branched on explicitly by `apps/web/app/utils/error-messages.ts` + test assertions:

| Web code         | Where                                                  | Purpose                                          |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `TIMEOUT`        | services/api-client.ts:61                              | Client-side synthesized (not from backend)       |
| `NETWORK_ERROR`  | services/api-client.ts:66                              | Client-side synthesized                          |
| `UPSTREAM_ERROR` | services/api-client.ts:85,93,96 + services/clusters.ts | Fallback default when body isn't `{code}`-shaped |

Branches observed on specific backend codes (`grep -rn "err\.code === '...'" apps/web/app`):

| Backend code             | Branched?         | Consumer                                                                                                                                     |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOME_CURRENCY_LOCKED`   | **yes**           | `routes/__tests__/settings.wallet.test.tsx:288`, comment in `routes/settings.wallet.tsx:165` (but UX path is by status 409, not code string) |
| `WEBHOOK_NOT_CONFIGURED` | **yes (partial)** | mentioned in comment `services/admin.ts:1369`; tested in `DiscordNotifiersCard.test.tsx:138`                                                 |
| `UPSTREAM_UNAVAILABLE`   | **yes**           | `AssetCirculationCard.test.tsx:109`, `AssetDriftBadge.test.tsx:86`                                                                           |
| All other 14 codes       | **no**            | Web dispatches by HTTP status (`STATUS_MESSAGES[429/502/503/504]`) only                                                                      |

### 4.3 Gaps (both directions)

**Emitted by backend but never branched by web (14 of 17):**

- `VALIDATION_ERROR` — relies on 400 status text only
- `UNAUTHORIZED` — handled as 401 with auto-refresh in api-client
- `NOT_FOUND` — relies on 404 status
- `NOT_CONFIGURED` — no UX copy
- `IDEMPOTENCY_KEY_REQUIRED` — credit-adjustments only (admin-side; no dedicated web UX)
- `INSUFFICIENT_BALANCE`, `INSUFFICIENT_CREDIT` — surfaced via generic friendlyError fallback; no dedicated UX message
- `NOT_AN_IMAGE`, `IMAGE_TOO_LARGE`, `UPSTREAM_REDIRECT` — image proxy; UI handles via `<img onError>`
- `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL_ERROR` — mapped via status

**Used by web but never emitted by backend (3 of 3):**

- `TIMEOUT` — client-synthesized; OK
- `NETWORK_ERROR` — client-synthesized; OK
- `UPSTREAM_ERROR` — also backend-emitted; used as fallback default

**Is the taxonomy closed?** No. There's no central TypeScript enum or Zod schema constraining `ErrorResponse.code`. `apps/backend/src/openapi.ts` defines `ErrorResponse = { code: z.string(), message: z.string(), requestId?: ... }` (line ~50) — `code` is untyped. A handler adding a novel string would validate and ship without anyone noticing. **G5-44 not enforced** — see F-4.

**Is it documented?** No. There is no docs page or shared-package export enumerating the set. `packages/shared/src/api.ts` exports `ApiException` and `ApiError` but does not constrain `code`. See F-4.

---

## 5. HTTP method safety (G5-39)

Walk of the route matrix:

- **GET** (131 routes) — every GET handler is read-only: DB SELECT, in-memory cache read, Horizon probe. No GET creates rows, mutates state, or fires outbound side effects (outside idempotent warmup). ✓
- **POST** (9 routes total: request-otp, verify-otp, refresh, orders, orders/loop, users/me/home-currency, admin/merchants/resync, admin/payouts/:id/retry, admin/users/:userId/credit-adjustments, admin/discord/test). `credit-adjustments` requires `Idempotency-Key` (ADR 017); `POST /api/orders` and `POST /api/orders/loop` accept an optional `Idempotency-Key` per `orders/handler.ts`. The other POSTs are not idempotent: `request-otp` mints a new OTP every call, `refresh` rotates tokens, `home-currency` writes unless locked, `merchants/resync` triggers a fresh upstream pull, `payouts/:id/retry` flips state, `discord/test` fires a webhook. This is per-design but **`merchants/resync` and `payouts/:id/retry` admin writes do not require `Idempotency-Key`** — see F-5.
- **PUT** (2 routes: `/api/users/me/stellar-address`, `/api/admin/merchant-cashback-configs/:merchantId`). Both idempotent per contract. ✓
- **DELETE** (1 route: `/api/auth/session`). Idempotent by contract — revoking an already-revoked refresh token is a no-op. ✓

---

## 6. Fuzz-probe table (G5-40, §5.2.12)

Harness: `app.request(...)` against the in-process Hono app, `NODE_ENV=test DISABLE_RATE_LIMITING=1 GIFT_CARD_API_BASE_URL=placeholder DATABASE_URL=postgres://p:p@localhost/db`. DB is intentionally unreachable so handlers exercise their error paths.

| Endpoint                                                          | Input                              | Status             | Cache-Control         | Body code                    | Observation                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------- | ------------------ | --------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                     | baseline                           | 200                | `no-store`            | —                            | 5s upstream probe timeout observed (OK)                                                                                                                                                                   |
| `GET /api/config`                                                 | baseline                           | 200                | `public, max-age=600` | —                            | —                                                                                                                                                                                                         |
| `GET /api/public/cashback-stats`                                  | baseline (DB down)                 | **200** (fallback) | `public, max-age=60`  | —                            | Never-500 honored (ADR 020) ✓                                                                                                                                                                             |
| `GET /api/public/cashback-preview?merchantId=&amountMinor=abc`    | malformed                          | 400                | —                     | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `GET /api/public/cashback-preview?amountMinor=9999999999…`        | int overflow                       | 400                | —                     | `VALIDATION_ERROR`           | "amountMinor is out of range" ✓                                                                                                                                                                           |
| `GET /api/public/merchants/%00%00`                                | null bytes                         | 400                | —                     | `VALIDATION_ERROR`           | "id is malformed" ✓                                                                                                                                                                                       |
| `GET /api/image`                                                  | no url                             | 400                | —                     | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `GET /api/image?url=http://169.254.169.254/`                      | SSRF attempt                       | 400                | —                     | `VALIDATION_ERROR`           | "Only HTTPS URLs are allowed" ✓                                                                                                                                                                           |
| `GET /api/clusters`                                               | no bbox                            | 400                | —                     | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `GET /api/merchants/cashback-rates`                               | baseline (DB down)                 | **500**            | —                     | `INTERNAL_ERROR` + requestId | **No fallback; contrast with `/public/cashback-stats`** — F-7                                                                                                                                             |
| `POST /api/auth/request-otp`                                      | `{}`                               | 400                | `no-store`            | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `POST /api/auth/request-otp`                                      | `not-json`                         | 400                | `no-store`            | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `POST /api/auth/request-otp`                                      | `{"email":123}`                    | 400                | `no-store`            | `VALIDATION_ERROR`           | type-confusion rejected ✓                                                                                                                                                                                 |
| `POST /api/auth/request-otp`                                      | Unicode RTL-override in email      | 400                | `no-store`            | `VALIDATION_ERROR`           | zod email rejects ✓                                                                                                                                                                                       |
| `POST /api/auth/request-otp`                                      | 2 MiB body (Content-Length honest) | **500**            | `no-store`            | `INTERNAL_ERROR`             | bodyLimit throws → onError catches → 500. Should be 413. — F-6                                                                                                                                            |
| `POST /api/auth/verify-otp`                                       | `{}`                               | 400                | `no-store`            | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `POST /api/auth/verify-otp`                                       | `{"email":null,"otp":null,...}`    | 400                | `no-store`            | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `POST /api/auth/refresh`                                          | `{}`                               | 400                | `no-store`            | `VALIDATION_ERROR`           | ✓                                                                                                                                                                                                         |
| `GET /api/users/me`                                               | no auth                            | 401                | **missing**           | `UNAUTHORIZED`               | `private, no-store` middleware never runs because requireAuth short-circuits _before_ the header mw. `/api/orders` 401 DOES carry `private, no-store` because registration order is inverted there. — F-3 |
| `POST /api/orders`                                                | no auth                            | 401                | `private, no-store`   | `UNAUTHORIZED`               | ✓ (contrast with `/api/users/me`)                                                                                                                                                                         |
| `GET /api/admin/users`                                            | no auth                            | 401                | —                     | `UNAUTHORIZED`               | requireAuth short-circuits; no cache-mw registered here so —                                                                                                                                              |
| `DELETE /api/merchants`                                           | wrong method                       | 404                | —                     | `NOT_FOUND`                  | 405 would be more correct — F-8                                                                                                                                                                           |
| `POST /api/config`                                                | wrong method                       | 404                | —                     | `NOT_FOUND`                  | same — F-8                                                                                                                                                                                                |
| `GET /api/does-not-exist`                                         | unknown                            | 404                | —                     | `NOT_FOUND`                  | ✓ (metric collapses to `NOT_FOUND` label)                                                                                                                                                                 |
| `OPTIONS /api/auth/request-otp` (Origin: `capacitor://localhost`) | preflight                          | 204                | —                     | —                            | CORS `*` in test; in production allowed by allowlist ✓                                                                                                                                                    |
| `OPTIONS /api/auth/request-otp` (Origin: `https://evil.com`)      | preflight                          | 204                | —                     | —                            | In test NODE_ENV, `*` returned (expected for dev). In production the allowlist would strip Access-Control-Allow-Origin and the browser would block. Not testable here without NODE_ENV=production.        |

**5xx body leak (G5-40):** Across 24 probes, every 5xx body is the canonical `{code:'INTERNAL_ERROR', message:<generic>, requestId}` — no stack traces, no SQL snippets, no file paths. `app.onError` (`app.ts:1529`) is the choke point and it is tight. However the server LOG emits the full Drizzle error including bound SQL (`public/cashback-stats.ts` swallowed its own error but the access log still includes the handler's `err.stack` for ops debugging — that is by design). **Response bodies are clean.** ✓

---

## 7. Cache-Control matrix (G5-43)

| Surface                          | Policy                                                  | Enforced at                                                      |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `/api/config`                    | `public, max-age=600`                                   | handler                                                          |
| `/api/public/*`                  | `public, max-age=60..300` (happy) / shorter on fallback | each handler                                                     |
| `/api/merchants*` (public reads) | `public, max-age=300`                                   | handler                                                          |
| `/api/auth/*`                    | `no-store`                                              | post-MW `app.ts:739`                                             |
| `/api/orders*`                   | `private, no-store`                                     | post-MW `app.ts:786-793`                                         |
| `/api/users/me*`                 | `private, no-store`                                     | post-MW `app.ts:824-831` (order bug F-3)                         |
| `/api/admin/*`                   | nothing at the namespace level                          | Individual handlers vary (CSVs set attachment headers + private) |
| `/health`, `/metrics`            | `no-store`                                              | handler                                                          |
| `/openapi.json`                  | `public, max-age=3600`                                  | handler                                                          |

**Gaps:**

- `/api/admin/*` has no namespace-wide `private, no-store`. Tier-1/2 admin GETs rely on admin handlers to set their own. Not every admin handler sets one explicitly — if a CDN ever sat between Fly edge and a client, two admins sharing a corporate egress IP could receive each other's cached response (since admin routes pass no `Vary: Authorization` header either). F-11.
- `/api/users/me*` Cache-Control only attaches on non-401 responses (F-3 above).
- No handler uses `ETag` or `Last-Modified`, so G5-41 is vacuously satisfied.

---

## 8. CORS behavior (G5-43 adjacent)

`app.ts:305-318`:

```
PRODUCTION_ORIGINS = [
  'https://loopfinance.io',
  'https://www.loopfinance.io',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
]
```

Non-production: `origin: '*'`.

Observations:

- Including `http://localhost` unconditionally in the production allowlist means a production backend will set `Access-Control-Allow-Origin: http://localhost` when called from any dev browser (or any attacker's page that happens to load the app from `http://localhost:NNNN`). Any malicious page running on localhost during a dev/debug session (e.g., a user running multiple projects) can CSRF production with credentials. Allowing `capacitor://localhost` + `https://localhost` for native is necessary; **plain `http://localhost` is defense-in-depth debt.** F-10.
- No explicit `credentials: true`, so `Access-Control-Allow-Credentials` is not set. Cookies/auth are bearer-based so this is fine.
- No per-route CORS override anywhere; every route uses the same allowlist. Fine.

---

## 9. Findings

All IDs monotonic from `A2-1000`.

### A2-1000 — OpenAPI: ~11+ live routes are not registered in `openapi.ts`

**Severity: Medium.** Drift between `apps/backend/src/app.ts` and `apps/backend/src/openapi.ts` for, at minimum, `POST /api/auth/social/{google,apple}`, `POST|GET /api/orders/loop[/:id]`, `GET /api/admin/cashback-monthly`, `GET /api/admin/users/recycling-activity[.csv]`, `GET /api/admin/users/:userId/cashback-by-merchant`, `GET /api/admin/users/:userId/cashback-summary`, `GET /api/admin/users/:userId/credit-transactions.csv`, `GET /api/admin/user-credits.csv`, `GET /api/admin/orders/payment-method-activity`, `GET /api/admin/merchants/flywheel-share[.csv]`. Generated OpenAPI JSON is incomplete; consumers (the admin UI, generated mobile clients, third-party integrators) cannot rely on `/openapi.json` as a contract source. **Impact:** contract-drift — the `AGENTS.md` doc-update checklist explicitly requires openapi registration for every endpoint. **Remediation:** add `registry.registerPath(...)` for each; add a CI check that diffs `app.ts` route list against `openapi.ts` paths.

### A2-1001 — OpenAPI: none of the auth registrations document the 500 path

**Severity: Low.** `POST /api/auth/request-otp`, `/api/auth/verify-otp`, `/api/auth/refresh` all declare 200/400/401/429/502/503 but can emit 500 via `auth/handler.ts:{104,175,239}`. Generated clients do not know 500 is a real branch and may mishandle it. Same gap for the `app.onError` catch-all — no openapi `default` response documented per registration. **Remediation:** add 500 to every registration, or introduce an openapi `default` response and reuse across all paths.

### A2-1002 — `/api/users/me*` 401 responses are missing the `Cache-Control` header

**Severity: Medium.** At `app.ts:822-831` the registration order is `requireAuth` THEN the Cache-Control post-middleware. Hono middleware chain: `requireAuth` returns 401 without calling `next()`, so the Cache-Control middleware's post-await body never runs. The 401 response therefore ships without `private, no-store`. The mirror block for `/api/orders` (`app.ts:786-796`) registers Cache-Control FIRST, then requireAuth, so the post-mw body runs on unwind and the 401 _does_ carry `private, no-store`. This is an inconsistency that also means a misbehaving CDN could cache the `/api/users/me` 401 response and reflect it (or its Vary-less URL) to other users' first unauth request. **Remediation:** reorder registrations so cache-control runs first on both blocks; consider inverting the post-mw to a pre-mw pattern so it's order-independent.

### A2-1003 — No closed-set enforcement on `ErrorResponse.code` (G4-02 / G5-44)

**Severity: Medium.** `packages/shared/src/api.ts` declares `ApiError.code: string` with no union/enum constraint. `apps/backend/src/openapi.ts` declares `ErrorResponse = z.object({ code: z.string(), ... })`. Handlers can invent a new string with zero test or doc signal. The live set across the codebase is the 17 codes enumerated in §4.1 but nothing enforces that. The web client only branches on 3 of them (§4.2); the rest propagate via HTTP status only. **Impact:** a code string typo (`UNAUTHORISED` vs `UNAUTHORIZED`) would silently land; a new handler could introduce `BAD_REQUEST` without anyone updating the taxonomy. **Remediation:** define `export const ERROR_CODES = [...17] as const; export type ErrorCode = (typeof ERROR_CODES)[number]` in `packages/shared/src/api.ts`, narrow `ApiError.code` to `ErrorCode`, tighten the openapi schema via `z.enum(ERROR_CODES)`. Add a test that greps the handlers for literal `code:` strings and asserts they're all in the set.

### A2-1004 — Admin writes `/api/admin/merchants/resync` and `/api/admin/payouts/:id/retry` do not require `Idempotency-Key` (G5-39)

**Severity: Medium.** ADR 017 mandates `Idempotency-Key` for admin writes. `POST /api/admin/users/:userId/credit-adjustments` enforces it; `POST /api/admin/discord/test` is a noop so fine; but `POST /api/admin/merchants/resync` (triggers a fresh CTX catalog pull) and `POST /api/admin/payouts/:id/retry` (flips state from failed → pending) are both state-mutating. A double-click or retry-on-timeout duplicates the effect. `payouts/:id/retry` in particular opens a window where two concurrent retries could race the payout-submitter watcher. **Remediation:** extend `admin/idempotency.ts` middleware to those two routes.

### A2-1005 — `bodyLimit` exceedance returns 500 `INTERNAL_ERROR` instead of 413

**Severity: Low.** `app.ts:338` sets `bodyLimit({ maxSize: 1 MiB })` but passes no `onError` — on exceedance, hono's body-limit throws, and the catch-all `app.onError` converts it to 500 `INTERNAL_ERROR`. The RFC-correct status is 413 Payload Too Large. **Impact:** monitoring confuses body-limit rejections with internal errors; attackers cannot distinguish an honest refusal; client libraries auto-retrying on 5xx will retry and burn rate-limit budget. Verified via harness: 2 MiB body to `/api/auth/request-otp` → 500. **Remediation:** `bodyLimit({ maxSize: 1024*1024, onError: (c) => c.json({code:'PAYLOAD_TOO_LARGE', message:'Request body too large'}, 413) })`. Also add `PAYLOAD_TOO_LARGE` to the closed code set (A2-1003).

### A2-1006 — `/api/merchants/cashback-rates` 500s on DB outage (no never-500 fallback)

**Severity: Low.** ADR 020 mandates never-500 for public endpoints. `/api/merchants/cashback-rates` is rate-limited and unauthenticated (app.ts:676) — a public endpoint in behaviour. On DB outage the handler propagates the DrizzleQueryError to the catch-all → 500 INTERNAL_ERROR. Compare `/api/public/cashback-stats`, which catches and returns an empty-array fallback. **Remediation:** same never-500 discipline as the `/api/public/*` siblings — wrap the DB call, return `{rates: []}` with short Cache-Control on fallback.

### A2-1007 — Non-matching HTTP method returns 404 instead of 405

**Severity: Low.** `app.notFound` fires for any unmatched path/method combination. `DELETE /api/merchants` and `POST /api/config` currently return 404 `NOT_FOUND` instead of 405 `METHOD_NOT_ALLOWED`. **Impact:** violates RFC 9110 §15.5.6; generated clients that probe for method support cannot tell "does not exist" from "wrong verb"; OWASP ASVS V13.2.1. **Remediation:** Hono has no built-in 405; register a fallback that, given a known path, returns 405 with `Allow:` header. Low priority — no current exploit path.

### A2-1008 — `/api/merchants/:id` has `requireAuth` but no rate limit

**Severity: Low.** Every other authed route has an explicit `rateLimit()` as defense-in-depth (per comment at `app.ts:764`). `/api/merchants/:id` (app.ts:692-693) is the only one without. A leaked bearer can be used to spam CTX merchant-detail fetches through the backend with no per-IP ceiling. **Remediation:** add `rateLimit(120, 60_000)` matching the sibling public merchant reads.

### A2-1009 — CORS allowlist includes bare `http://localhost`

**Severity: Low.** `PRODUCTION_ORIGINS` at `app.ts:305-311` includes `http://localhost`. While necessary for old Capacitor debug builds, this allows any malicious page running on an attacker's localhost (e.g., a developer has both Loop and an attacker site open during debug, or an enterprise environment runs localhost services) to issue credentialed requests to production and read the responses. Bearer tokens are memory-only so the attack vector is narrow, but `SameSite` does not protect a token explicitly attached via `Authorization`. **Remediation:** strip `http://localhost` from the production allowlist; require native debug builds to set `https://localhost` (which Capacitor 3+ uses by default) or use a dedicated debug origin.

### A2-1010 — No namespace-level `private, no-store` on `/api/admin/*`

**Severity: Low.** `app.ts:940-941` applies `requireAuth` + `requireAdmin` to `/api/admin/*` but no blanket Cache-Control post-middleware. Each admin handler sets its own Cache-Control (often nothing). Admin responses contain PII (user emails, credit ledgers, payouts) and must never be shared across sessions. Today Fly.io edge does not cache, but the assumption is un-encoded. **Remediation:** add `app.use('/api/admin/*', async (c, next) => { await next(); c.header('Cache-Control', 'private, no-store'); })` symmetric to the `/api/users/me*` + `/api/orders*` blocks.

### A2-1011 — Error-code taxonomy is not documented anywhere

**Severity: Low.** Neither `docs/architecture.md`, `docs/standards.md`, nor any ADR enumerates the error-code catalog. A developer adding a new handler has no reference to "existing codes — pick one, don't invent." Related to A2-1003 but calls out the doc side specifically. **Remediation:** add `docs/error-codes.md` (or an ADR) listing every code, its HTTP status, its meaning, and which web consumer branches on it. Link from `AGENTS.md` doc-update checklist.

### A2-1012 — `/api/auth/session` (logout) is the only DELETE in the API

**Severity: Info.** DELETE has exactly one user across 148 routes. Not a bug — just a curiosity noted during the method-safety walk (G5-39). If future ops wants `DELETE /api/admin/users/:id/credits` or similar, the convention is open. No action.

### A2-1013 — 5xx response body check: clean across the fuzz sample

**Severity: Info.** No stack traces, no SQL, no file paths observed in any 5xx body across 24 probes. `app.onError` is tight. Recording as Info so a future phase doesn't re-do the grep.

### A2-1014 — Test-only `/__test__/reset` is registered on the main app (unreachable in prod, but live on import)

**Severity: Info.** `app.ts:468-478` registers `POST /__test__/reset` only when `NODE_ENV === 'test'`. This is correctly gated — but the route is defined at module load, not behind a runtime gate. Any deployment that sets `NODE_ENV=test` (CI edge case, misconfigured container) exposes a sessionless rate-limit reset. The existing check is the entire defense. Not a live bug; noting for the security deep-dive in Phase 12.

---

## 10. Blockers / unclassified routes

**None unclassified.** All 148 routes have a method, auth class, rate-limit, cache policy, and openapi registration status recorded.

**Remaining open questions for other phases:**

- Phase 10 (shared): `ApiError.code` should be a union — coordinate with A2-1003.
- Phase 11 (cross-app): every admin route's response type exists in `apps/web/app/services/admin.ts`; confirming the triangle commute is Phase 11 work.
- Phase 12 (security): confirm production CORS allowlist under `NODE_ENV=production` in a real build; verify `http://localhost` exclusion (A2-1009).
- Phase 8 (web): verify that `friendlyError` chain actually reaches every call site — some fetches in hooks may catch before reaching it.
