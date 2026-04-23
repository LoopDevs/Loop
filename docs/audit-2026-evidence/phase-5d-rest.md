# Phase 5d — Backend clustering / merchants / images / public + top-level files

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 5d)
**Scope:** `apps/backend/src/clustering/`, `apps/backend/src/merchants/`, `apps/backend/src/images/`, `apps/backend/src/public/`, plus top-level `app.ts`, `index.ts`, `env.ts`, `logger.ts`, `upstream.ts`, `circuit-breaker.ts`, `discord.ts`, `openapi.ts`. Tests in `__tests__/` consulted only as coverage pointers.
**Out of scope:** `admin/`, `auth/`, `ctx/`, `users/`, `config/`, `orders/`, `payments/`, `credits/`, `db/` — covered by parallel Phase-5 agents.

Primary evidence: direct file reads with line numbers, grep outputs proving symbol usage, shell-assembled diff of `app.ts` ↔ `openapi.ts` path registrations, shell-assembled diff of `env.ts` zod schema ↔ source `env.XXX` usages ↔ `.env.example`.

---

## 1. Middleware chain walk (app.ts)

Expected order per `AGENTS.md §Backend middleware stack`:
CORS → secure-headers → body-limit → request-id → logger → rate-limit → circuit-breaker.

| Expected slot   | Actual line(s) in `apps/backend/src/app.ts`                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry (global) | L156–163 — wraps entire app when `env.SENTRY_DSN` is set (pre-CORS, by design: Sentry must see preflight / 4xx too).                                     |
| CORS            | L313–318 — `env.NODE_ENV === 'production' ? PRODUCTION_ORIGINS : '*'`. Prod list (L305–311) matches AGENTS.md summary including Capacitor origins.       |
| secure-headers  | L319–337 — HSTS + XCTO + XFO via `hono/secure-headers`; adds explicit CSP (`default-src 'none'` etc.) and toggles `Cross-Origin-Resource-Policy` by env. |
| body-limit      | L338 — 1 MB (`1024 * 1024`).                                                                                                                             |
| request-id      | L339 — `requestId()` Hono middleware.                                                                                                                    |
| access log      | L350–366 — **Pino-backed** (audit A-021 replacement), child logger `{component:'access'}`, emits `method/path/status/durationMs/requestId`.              |
| metrics counter | L390–401 — **after** the handler, observes final status. Collapses unmatched routes to `NOT_FOUND` (audit A-022 fix).                                    |
| rate-limit      | Per-route (L648 clusters, L662 image, L657 config, L676 cashback-rates, L699 public endpoints, etc.). No global limiter by design.                       |
| circuit-breaker | Per-upstream at call site via `getUpstreamCircuit(key).fetch(…)` (`circuit-breaker.ts:187`).                                                             |

Chain ordering matches the contract. Access-logger inside the `*` middleware emits _after_ `next()` so `c.res.status` is set; `requestId` middleware is registered before the access logger so the context var is populated by the time the log line renders.

### `/health` flap-damping

`app.ts:482–640` — verified live:

- Per-probe cache 10 s (`UPSTREAM_PROBE_TTL_MS`, L510) + in-flight coalesce (L543).
- Streak thresholds: `HEALTH_FLIP_TO_DEGRADED_STREAK = 2`, `HEALTH_FLIP_TO_HEALTHY_STREAK = 3` (L489–490).
- 5 min notify cooldown via `maybeNotifyHealthChange` (L528–533).
- Bootstrap seed: first `/health` hit latches `lastHealthStatus` without notifying (L602–603).
- `Cache-Control: no-store` enforced (L628) — stops CDN caching the healthy value across an outage.
- Dedicated test seams exported (`__resetHealthProbeCacheForTests`, `__resetUpstreamProbeCacheOnlyForTests`).

### Rate-limit map

`app.ts:249 RATE_LIMIT_MAP_MAX = 10_000`. Eviction path (L275–278) only fires when `entry === undefined` — i.e. inserting a fresh IP. Expired entries on the same IP overwrite in place without contributing to eviction (L272 then L279). `clientIpFor` (L187–203) honours `env.TRUST_PROXY`: when true, trusts XFF leftmost; when false, `getConnInfo(c).remote.address`; `try/catch` falls through to `'unknown'`. 429 path emits `Retry-After` (L286) and increments `metrics.rateLimitHitsTotal`.

### Test-only reset endpoint

L472–478: `POST /__test__/reset` is registered **only** when `env.NODE_ENV === 'test'`. Outside the `/api` namespace (per comment) so it doesn't pollute OpenAPI or `architecture.md` route coverage. Deliberate.

### Graceful shutdown (index.ts)

`index.ts:91–141` — single-signal latch (`shuttingDown`), cancels `locationStartTimer`, drains workers (merchant-refresh, location-refresh, payment-watcher, procurement, payout, asset-drift), then `server.close` + `sentryFlush(5000)` + `closeDb()`. `unhandledRejection` / `uncaughtException` hand off to `shutdown` (L134–141). 10 s force-exit timer is `.unref()`'d. Clean.

---

## 2. Per-file disposition

| File                                                        | Disposition        | Notes                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/app.ts` (1562 L)                          | audited-findings-5 | Middleware chain matches AGENTS.md. See A2-650 (merchant-list routes missing rate-limit), A2-651 (Hono route-match ordering comment wrong), A2-660 (unthrottled `/health`/`/metrics`), A2-661 (expired-entry rate-limit map drift), A2-667 (`/health` probe bypasses circuit but not memoised flap).                                                                          |
| `apps/backend/src/index.ts` (141 L)                         | audited-clean      | Bootstrap + shutdown hygienic. Skips migrations in test (by design).                                                                                                                                                                                                                                                                                                          |
| `apps/backend/src/env.ts` (369 L)                           | audited-findings-4 | See A2-652 (`LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS` declared but unused → ADR-016 rotation unimplemented), A2-653 (`.env.example` carries vars not in the zod schema), A2-654 (`IMAGE_PROXY_ALLOWED_HOSTS` boot-refuse bypass token `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT` is undocumented in schema), A2-674 (`z.string().url()` allows `ftp://` for Discord webhooks). |
| `apps/backend/src/logger.ts` (96 L)                         | audited-findings-1 | See A2-655 (redact list misses `LOOP_JWT_SIGNING_KEY*`, `DATABASE_URL`, `DISCORD_WEBHOOK_*`, `GIFT_CARD_API_KEY`/`_SECRET` — env-name variants).                                                                                                                                                                                                                              |
| `apps/backend/src/upstream.ts` (48 L)                       | audited-clean      | URL-traversal / CRLF / percent-encoded traversal / protocol-relative all rejected. Defence in depth over handler-level validation.                                                                                                                                                                                                                                            |
| `apps/backend/src/circuit-breaker.ts` (206 L)               | audited-clean      | State machine correct; 4xx does NOT trip (L136); probe timeout failsafe (L58–74); per-key breakers independent; `.unref()` timer; `reset()` clears `halfOpenInFlight` and `probeTimer`.                                                                                                                                                                                       |
| `apps/backend/src/discord.ts` (791 L)                       | audited-findings-3 | See A2-656 (catalog ordering violates its own "sort by channel then name" rule — `notifyHealthChange` misplaced), A2-657 (`notifyCashbackCredited` uses first-8-of-uuid vs other notifiers' last-8), A2-658 (`formatAmount` downstream trusts unvalidated `currency` string; safely escapes, but any non-ASCII length > 1024 chars would still fit the field cap unchecked).  |
| `apps/backend/src/openapi.ts` (5922 L)                      | audited-findings-7 | See A2-662 / A2-663 / A2-664 / A2-665 / A2-666 / A2-668 / A2-675 (route registrations drifted vs `app.ts`; several status codes undocumented).                                                                                                                                                                                                                                |
| `apps/backend/src/clustering/algorithm.ts` (194 L)          | audited-clean      | Non-finite coord guard + explicit bounds clip + grid-cell float-safe math (L108 commentary). `pointCount` using full-cell size vs visible subset is tested in `clustering/__tests__/algorithm.test.ts:114–127` — intentional.                                                                                                                                                 |
| `apps/backend/src/clustering/data-store.ts` (213 L)         | audited-findings-1 | See A2-659 (MAX_PAGES cap silently truncates when exceeded — log.warn but no metric / Discord paging).                                                                                                                                                                                                                                                                        |
| `apps/backend/src/clustering/handler.ts` (182 L)            | audited-clean      | Protobuf negotiation — `Vary: Accept` correctly set on both branches (L166, L173). Dynamic proto import failure falls back to JSON (L113). The `lat/lng` clamp (L56 `Math.max(0, Math.min(28, rawZoom))`) drops a NaN-zoom request from the 400 path into the happy path — BUT the earlier `Number.isFinite` check (L24) already rejects NaN. Safe.                           |
| `apps/backend/src/merchants/sync.ts` (314 L)                | audited-findings-1 | See A2-669 (merchants-sync refresh interval never deduplicates a concurrent admin `forceRefreshMerchants` + background tick — `isMerchantRefreshing` is a single boolean, not a promise, so the loser silently returns `{ triggered: false }` with no hint of the in-flight merge).                                                                                           |
| `apps/backend/src/merchants/handler.ts` (272 L)             | audited-findings-2 | See A2-670 (`merchantsCashbackRatesHandler` / `merchantCashbackRateHandler` have no try/catch — a DB outage emits 500 while the bulk endpoint sits behind a merchant-catalog page that's a _public_ read), A2-671 (`merchantDetailHandler` trusts `c.get('bearerToken')` as `string \| undefined` via an `as` cast — no runtime guard).                                       |
| `apps/backend/src/images/proxy.ts` (363 L)                  | audited-findings-2 | See A2-672 (DNS-rebinding TOCTOU documented but NOT mitigated — comment L233 acknowledges the hole, boot-refuse env check forces the allowlist in prod but not in dev), A2-673 (image cache `totalCacheBytes` can drift negative on fast insert+evict race in the same tick — see evidence §3.7).                                                                             |
| `apps/backend/src/public/cashback-preview.ts` (192 L)       | audited-findings-1 | See A2-676 (`PublicCashbackPreview` interface defined in backend + redefined in `apps/web/app/services/public-stats.ts` instead of `@loop/shared` — violates ADR 019 single-source rule; other public types correctly live in shared).                                                                                                                                        |
| `apps/backend/src/public/cashback-stats.ts` (141 L)         | audited-clean      | Never-500 contract held. Fallback path emits `max-age=60`. DB errors log+fall-through. Zero-bootstrap shape is valid.                                                                                                                                                                                                                                                         |
| `apps/backend/src/public/flywheel-stats.ts` (117 L)         | audited-clean      | Same contract. `FALLBACK_ZERO` is the bootstrap.                                                                                                                                                                                                                                                                                                                              |
| `apps/backend/src/public/loop-assets.ts` (71 L)             | audited-clean      | Pure env read; try/catch maintains the uniform public-surface shape.                                                                                                                                                                                                                                                                                                          |
| `apps/backend/src/public/merchant.ts` (136 L)               | audited-findings-1 | See A2-677 (fallback bootstrap path always emits a fresh `asOf: new Date().toISOString()` — if DB is down for a sustained window every request advertises "as of now" while the `userCashbackPct` is the null bootstrap, misleading cache-age to consumers).                                                                                                                  |
| `apps/backend/src/public/top-cashback-merchants.ts` (107 L) | audited-clean      | Never-500; bootstraps to empty list; evicted-merchant (ADR 021 Rule B) pruning at L68–70 correct.                                                                                                                                                                                                                                                                             |

---

## 3. Discord-notifier catalog audit (discord.ts)

15 exported `notify*` functions (L96, 132, 176, 216, 257, 310, 328, 369, 394, 465, 524, 556, 579, 599, 675). 15 catalog entries (L701–791). No missing and no orphan entries — parity holds.

| `notify*` export              | channel used (env var)        | catalog entry present? | escape + truncate                                                                              | `allowed_mentions: {parse: []}` | PII scrub                                                                  |
| ----------------------------- | ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `notifyOrderCreated`          | `DISCORD_WEBHOOK_ORDERS`      | yes (L733)             | yes (L109/113/114)                                                                             | yes (L48)                       | merchantName + orderId only — no PII                                       |
| `notifyCashbackRecycled`      | `DISCORD_WEBHOOK_ORDERS`      | yes (L721)             | yes                                                                                            | yes                             | no userId in embed                                                         |
| `notifyFirstCashbackRecycled` | `DISCORD_WEBHOOK_ORDERS`      | yes (L727)             | yes                                                                                            | yes                             | `userEmail` leaked to channel (L195) — but admins-only channel, acceptable |
| `notifyOrderFulfilled`        | `DISCORD_WEBHOOK_ORDERS`      | yes (L738)             | yes                                                                                            | yes                             | no PII                                                                     |
| `notifyCashbackCredited`      | `DISCORD_WEBHOOK_ORDERS`      | yes (L715)             | yes; `userId.slice(0,8)` (inconsistent — see A2-657)                                           | yes                             | userId truncated                                                           |
| `notifyHealthChange`          | `DISCORD_WEBHOOK_MONITORING`  | yes (L768)             | truncate only; `details` not `escapeMarkdown`'d (L313) — caller-produced string, no user input | yes                             | no PII                                                                     |
| `notifyPayoutFailed`          | `DISCORD_WEBHOOK_MONITORING`  | yes (L774)             | yes                                                                                            | yes                             | full `userId`, `orderId`, `payoutId` (admin-channel)                       |
| `notifyUsdcBelowFloor`        | `DISCORD_WEBHOOK_MONITORING`  | yes (L780)             | yes                                                                                            | yes                             | account pubkey only                                                        |
| `notifyAdminAudit`            | `DISCORD_WEBHOOK_ADMIN_AUDIT` | yes (L703)             | yes; actorTail = last-8 (L405)                                                                 | yes                             | actorEmail + targetUserId tail only                                        |
| `notifyCashbackConfigChanged` | `DISCORD_WEBHOOK_ADMIN_AUDIT` | yes (L709)             | yes via `fmtConfigLine`                                                                        | yes                             | merchant id + actor tail                                                   |
| `notifyAssetDrift`            | `DISCORD_WEBHOOK_MONITORING`  | yes (L744)             | yes                                                                                            | yes                             | no PII                                                                     |
| `notifyAssetDriftRecovered`   | `DISCORD_WEBHOOK_MONITORING`  | yes (L750)             | yes                                                                                            | yes                             | no PII                                                                     |
| `notifyOperatorPoolExhausted` | `DISCORD_WEBHOOK_MONITORING`  | yes (L762)             | yes                                                                                            | yes                             | no PII                                                                     |
| `notifyCircuitBreaker`        | `DISCORD_WEBHOOK_MONITORING`  | yes (L756)             | truncate only; description is a fixed template string                                          | yes                             | no PII                                                                     |
| `notifyWebhookPing`           | any channel (via arg)         | yes (L786)             | yes; actor truncated to 8                                                                      | yes                             | no PII                                                                     |

`sendWebhook` (L34–68) is the single delivery point — every notifier goes through `allowed_mentions: {parse: []}`, 5 s `AbortSignal.timeout`, and non-success body logged truncated to 500 chars. No raw bodies forwarded. Good.

`webhookUrlFor(channel)` (L639–648) is the single channel → env mapping — used by both `hasWebhookConfigured` (admin 409 signal) and `notifyWebhookPing`. No duplication drift.

---

## 4. env.ts parity

### 4.1 `env.XXX` usage ↔ zod schema

Shell-assembled grep of every `env.<UPPERCASE>` reference across `apps/backend/src`, deduped, compared to zod schema root keys in `env.ts:39–280`:

```
comm -23 <used> <declared>  →  empty      (no consumer reads a var the schema doesn't declare)
comm -13 <used> <declared>  →  LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS
```

The single orphan is **LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS** — declared at env.ts:230, redacted at logger.ts:78/80, documented at ADR 016 L90, but **no source file reads `env.LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS`**. The `payout-worker.resolvePayoutConfig()` (payments/payout-worker.ts:282–293) only consumes `env.LOOP_STELLAR_OPERATOR_SECRET`. Finding A2-652: rotation semantics promised by ADR 016 are un-implemented.

### 4.2 `.env.example` ↔ zod schema

Shell-assembled grep of `apps/backend/.env.example` uncomment-or-commented var names vs zod keys:

```
In .env.example but NOT declared in env.ts:
  CTX_OPERATOR_POOL                            # read via process.env directly — ctx/operator-pool.ts:82
  DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT    # read via source['...']    — env.ts:356 (emergency override)
  LOOP_FX_FEED_URL                             # read via process.env      — payments/price-feed.ts:146
  LOOP_STELLAR_HORIZON_URL                     # read via process.env      — 4 files in payments/
  LOOP_XLM_PRICE_FEED_URL                      # read via process.env      — payments/price-feed.ts:54
In env.ts but NOT in .env.example: ∅
```

Every `.env.example` entry is used somewhere, but five env vars bypass the typed `env` object and read `process.env[...]` directly — A2-653. Per `AGENTS.md §Documentation update rules` + `scripts/lint-docs.sh` the `.env.example` is the authoritative reference and these vars are un-typed, un-validated, and un-boot-checked.

### 4.3 Boot-refuse (A-025)

`env.ts:352–363` enforces `IMAGE_PROXY_ALLOWED_HOSTS` must be set in `NODE_ENV=production` unless `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1`. The override token is read via `source['...']` (raw env bracket) instead of a declared zod field. Finding A2-654: un-typed emergency flag with footgun potential (silent bypass on typo).

---

## 5. openapi.ts vs app.ts route drift

Full method+path diff (shell-assembled). After normalising `{param}` → `:param` and excluding `app.use('*', …)` middleware registrations:

**Routes registered in `app.ts` but NOT in `openapi.ts`** (finding A2-662, scoped to in-scope paths only; admin-only gaps delegated to Phase 5a):

In-scope gaps (rest of `app.ts`):

- `POST /api/auth/social/google` (L754)
- `POST /api/auth/social/apple` (L755)
- `POST /api/orders/loop` (L805)
- `GET /api/orders/loop` (L809)
- `GET /api/orders/loop/:id` (L814)

Routes registered in `openapi.ts` but NOT in `app.ts`: none (every openapi path has an app.ts handler).

### 5.1 Status-code-documentation gaps

| Endpoint                                        | Emits (code)                                                                              | openapi docs                    | Gap                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------- | ---------------------------------- |
| `GET /api/merchants/{id}`                       | 200, 400 (`VALIDATION_ERROR`, handler L143), 404, 401 (via `requireAuth` middleware L692) | 200, 404                        | A2-663: 400, 401 undocumented |
| `GET /api/merchants/cashback-rates`             | 200, 500 (uncaught DB throw → `app.onError`), 429                                         | 200, 429                        | A2-664: 500 undocumented      |
| `GET /api/merchants/{merchantId}/cashback-rate` | 200, 400, 404, 500 (uncaught DB throw), 429                                               | 200, 400, 404, 429              | A2-665: 500 undocumented      |
| `GET /api/image`                                | 200, 400, 413, 429, 500 (fallback L169 `INTERNAL_ERROR`), 502                             | 200, 400, 413, 429, 502         | A2-666: 500 undocumented      |
| `POST /api/auth/social/*`, `POST                | GET /api/orders/loop\*`                                                                   | — (route not documented at all) | —                             | A2-662 (route-level gap, as above) |

### 5.2 Response-shape consistency spot-checks

- `PublicCashbackPreview` (openapi.ts:512) mirrors the backend handler's `PublicCashbackPreview` (cashback-preview.ts:58) — **but the web side** (`apps/web/app/services/public-stats.ts:65`) redeclares the same interface locally rather than importing from `@loop/shared`. The other three public shapes (`PublicCashbackStats`, `PublicTopCashbackMerchantsResponse`, `PublicMerchantDetail`) correctly live in `@loop/shared`. A2-676.

---

## 6. Logger redaction sweep

`logger.ts:16–81` REDACT_PATHS covers: `authorization`/`cookie` + headers variants; `accessToken`/`refreshToken`; `otp`/`code`/`password`; `apiKey`/`apiSecret`/`X-Api-Key`/`X-Api-Secret`; `secret`/`privateKey`/`secretKey`/`seedPhrase`/`mnemonic`; `operatorSecret`; `LOOP_STELLAR_OPERATOR_SECRET(_PREVIOUS)`.

Pino's `fast-redact` matches keys by **exact name** (wildcards only for depth). An env-dump log line would expose:

| Variable (declared at env.ts line)                                           | Sensitive value                    | Covered by REDACT_PATHS?                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `LOOP_JWT_SIGNING_KEY` (L141)                                                | ≥32-byte HS256 secret              | **no** — name contains neither `secret` nor `JWT`; no path matches        |
| `LOOP_JWT_SIGNING_KEY_PREVIOUS` (L145)                                       | HS256 secret                       | **no**                                                                    |
| `DATABASE_URL` (L115)                                                        | `postgres://user:PASSWORD@host/db` | **no**                                                                    |
| `DISCORD_WEBHOOK_ORDERS` (L101), `_MONITORING` (L102), `_ADMIN_AUDIT` (L107) | webhook secret in URL              | **no**                                                                    |
| `GIFT_CARD_API_KEY` (L69), `GIFT_CARD_API_SECRET` (L70)                      | upstream credentials               | **no** (paths cover `apiKey`/`apiSecret`, not `GIFT_CARD_API_KEY/SECRET`) |
| `SENTRY_DSN` (L110)                                                          | DSN with project token             | **no**                                                                    |
| `LOOP_STELLAR_OPERATOR_SECRET*`                                              | Stellar secret                     | **yes** (explicit paths L77–80)                                           |

This is the finding A2-655. Today no `logger.*({env})` exists in source, but any future caller or a Sentry event context dump would leak these. Belt-and-braces: add env-name variants.

---

## 7. Findings

All IDs A2-650 through A2-677 (28 findings). Every finding will be addressed regardless of severity per plan §3.4.

### A2-650 — Medium — `/api/merchants`, `/api/merchants/all`, `/api/merchants/by-slug/:slug` have no rate limit

`apps/backend/src/app.ts:666, 668, 669`. Unlike every other public read (`/api/clusters`, `/api/image`, `/api/config`, every `/api/public/*`, `/api/merchants/cashback-rates`), these three handlers are registered without a `rateLimit(…)` middleware. Each call walks the in-memory merchant list (~117 rows today, ADR 021 eviction-permitting). The `merchantListHandler` filter-and-slice is cheap but unbounded at the edge. An automated scraper can burn response-serialisation CPU unbounded; `merchantAllHandler` returns the full catalog every time — a compressed-response MB-scale spray at modest QPS will pressure the process. Remediation: add `rateLimit(120, 60_000)` to match the other merchant reads; document 429 in openapi.ts.

### A2-651 — Low — Stale comment on `/api/orders/loop` registration order

`apps/backend/src/app.ts:806–807` claims "Listed before :id so the path param doesn't capture 'list' or similar". In reality the `/api/orders/:id` handler is registered at L800, **before** `/api/orders/loop` at L809. Hono's regex-router prefers literal > param regardless of registration order, so behaviour is correct, but the comment is actively misleading. A reader reasoning about a future routing change may rely on this invariant. Remediation: fix the comment (either delete it, or move the `loop` handlers before `/:id` and keep the comment).

### A2-652 — High — `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS` declared but never consumed → ADR-016 key rotation un-implemented

`apps/backend/src/env.ts:230–233` declares the var, `apps/backend/src/logger.ts:78, 80` redacts it, `docs/adr/016-stellar-sdk-payout-submit.md:90` promises rotation support, `apps/backend/.env.example:174` documents it as `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS=SYYYY...`, but no source file reads it. `resolvePayoutConfig` in `apps/backend/src/payments/payout-worker.ts:282–293` reads only `LOOP_STELLAR_OPERATOR_SECRET`. Contrast: the JWT equivalent `LOOP_JWT_SIGNING_KEY_PREVIOUS` IS consumed by `auth/tokens.ts:125`. An ops attempt to rotate the Stellar operator secret per ADR 016 will silently fail — the var is accepted at boot and logged as redacted, giving the appearance of being wired up. Pre-launch this is low operational impact; post-launch a compromised operator key cannot be rotated without downtime. Remediation: either (a) implement rotation — allow `resolvePayoutConfig` to return the PREVIOUS key as an accepted-signer for in-flight tx resubmits during the TTL window — or (b) remove the declaration + ADR promise.

### A2-653 — Medium — Five operational env vars bypass the zod schema

Read via `process.env['KEY']`, not `env.KEY`:

- `CTX_OPERATOR_POOL` (ctx/operator-pool.ts:82)
- `LOOP_STELLAR_HORIZON_URL` (payments/horizon.ts:26, horizon-balances.ts:33, horizon-circulation.ts:32, horizon-trustlines.ts:30, payout-worker.ts:284–286)
- `LOOP_XLM_PRICE_FEED_URL` (payments/price-feed.ts:54)
- `LOOP_FX_FEED_URL` (payments/price-feed.ts:146)
- `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT` (env.ts:356 — see A2-654)

Consequences: (1) no boot-time validation — an unset or malformed URL fails at first call instead of at process start; (2) no redaction coverage if logged; (3) `docs/development.md` + `AGENTS.md §Environment variables (summary)` list these without a single-source to enforce; (4) `scripts/lint-docs.sh` parity check (which validates zod schema ↔ `.env.example`) cannot see these so it cannot flag drift. Remediation: declare each in `EnvSchema` (leveraging `z.string().url().optional()` for the URLs, `envBoolean.default(false)` for the flag) and route consumers through `env.XXX`. `CTX_OPERATOR_POOL` needs a JSON schema, but the existing ad-hoc parse logic can move into a zod `transform`.

### A2-654 — Medium — `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT` is an un-typed emergency flag

`apps/backend/src/env.ts:356` reads `source['DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT'] !== '1'`. This is the ONE exception that lets the boot-refuse check (A-025) pass in production without `IMAGE_PROXY_ALLOWED_HOSTS`. Without a zod declaration, (a) a typo like `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORECEMENT=1` silently does NOT bypass the check (visible, so possibly acceptable) but also (b) `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=true` / `=yes` / `=on` is **not** accepted, only the literal string `'1'` — unlike every other boolean env var, which goes through `envBoolean`. Inconsistent operator UX: someone who habitually writes `=true` gets a surprising boot-refuse. Remediation: declare as `envBoolean.default(false)`, enforce via `parsed.data` rather than `source[…]`.

### A2-655 — High — Pino redaction list misses six secret-bearing env-name keys

`apps/backend/src/logger.ts:16–81`. Missing keys: `LOOP_JWT_SIGNING_KEY`, `LOOP_JWT_SIGNING_KEY_PREVIOUS`, `DATABASE_URL`, `DISCORD_WEBHOOK_ORDERS`, `DISCORD_WEBHOOK_MONITORING`, `DISCORD_WEBHOOK_ADMIN_AUDIT`, `GIFT_CARD_API_KEY`, `GIFT_CARD_API_SECRET`, `SENTRY_DSN`. Pino's `fast-redact` matches keys by literal name; the existing `secret` / `apiKey` / `apiSecret` paths do NOT match these specific env-variable names. Any future `logger.info({env}, '…')` or an unhandled error serialising `process.env` leaks them to logs + Sentry. The operator Stellar secret is already explicitly covered (`LOOP_STELLAR_OPERATOR_SECRET*`, L77–80); the same treatment should extend to every secret-bearing env variable. Remediation: add the missing explicit path entries; also consider a `'**.LOOP_*'` glob and `'**.DISCORD_WEBHOOK_*'` (pino supports wildcard paths).

### A2-656 — Low — `DISCORD_NOTIFIERS` catalog violates its own ordering rule

`apps/backend/src/discord.ts:698–699` documents "Keep the entries sorted by channel first, then by function name so the admin-rendered table is stable and diff-friendly." Within the `monitoring` channel the entries are `notifyAssetDrift`, `notifyAssetDriftRecovered`, `notifyCircuitBreaker`, `notifyOperatorPoolExhausted`, `notifyHealthChange`, `notifyPayoutFailed`, `notifyUsdcBelowFloor`, `notifyWebhookPing`. `Health` < `Operator` alphabetically, so `notifyHealthChange` at L768 is misplaced (should precede `notifyOperatorPoolExhausted` at L762). Admin UI renders this list — the out-of-order entry surfaces. Remediation: move the `notifyHealthChange` entry up.

### A2-657 — Low — `notifyCashbackCredited` uses first-8 uuid slice; other notifiers use last-8

`apps/backend/src/discord.ts:280`: `` `\`${escapeMarkdown(args.userId.slice(0, 8))}…\`` ``. `notifyAdminAudit`at L405 uses`args.actorUserId.slice(-8)` (last 8) and the ADR-018 convention ("Actor id truncated to the last 8 chars" at discord.ts:390, 467) is "last 8". Inconsistent UX in Discord — the same user's truncated id shows two different substrings across two notifiers in the same channel. Remediation: pick last-8 and use it everywhere, or document the divergence.

### A2-658 — Info — `formatAmount` accepts any `currency` string with ≤1024-char escape fits the field cap unchecked

`apps/backend/src/discord.ts:88–93`. `formatAmount` looks up `CURRENCY_SYMBOLS[currency.toUpperCase()]` and falls back to `${escapeMarkdown(currency)}` as the trailing token. Every call site passes the order's persisted currency (catalog-derived, e.g. `USD`, `GBP`, `EUR`, `CAD`) so in practice it's bounded. But the function has no explicit length cap of its own — a hypothetical upstream bug producing a 2000-char currency string would render a single Discord embed field that tripled in size and could push the embed past the 6000-char total limit. Cheap fix: `truncate(escapeMarkdown(currency), 16)` inside `formatAmount`.

### A2-659 — Low — MAX_PAGES cap on location / merchant sync is silent

`apps/backend/src/clustering/data-store.ts:165–167` and `apps/backend/src/merchants/sync.ts:185–187` both log `.warn({page,totalPages}, 'Hit MAX_PAGES cap … truncating')` when the upstream reports more pages than the cap. No Prometheus metric (no new counter in `metrics.requestsTotal`), no Discord notify, no `/health` degradation. If CTX grows the catalog past 500 location pages (500 × 1000 = 500 000 rows) or 100 merchant pages (100 × 100 = 10 000 rows), the map silently serves a subset until someone greps logs. Remediation: emit a dedicated metric + Discord `monitoring` notify on the first tick that hits the cap.

### A2-660 — Info — `/health` and `/metrics` are un-rate-limited

`apps/backend/src/app.ts:570` and `:403`. `/health` has a 10 s upstream-probe cache so outbound traffic is bounded, but CPU / sockets / Pino log lines scale 1:1 with request rate. `/metrics` has no cache — every hit walks the full `metrics.requestsTotal` map and emits the circuit-state gauge. Operationally these are typically firewalled to internal / prober IPs, but the backend exposes them on the public port at `0.0.0.0:8080`. Pure DoS surface. Remediation: either scope-restrict via a `trustedSources` middleware OR add a generous rate limit (e.g. 600/min).

### A2-661 — Low — Rate-limit map's expired-entry path does not contribute to eviction

`apps/backend/src/app.ts:272–289`. The eviction check `if (rateLimitMap.size >= RATE_LIMIT_MAP_MAX && entry === undefined)` (L275) only fires when the IP is brand new. When an existing entry has expired (`now > entry.resetAt`) the code overwrites the slot (L279) without evicting. In steady state this is fine because the periodic cleanup (`runCleanup` L1540, 1-hour cadence) removes expired entries — but between cleanup ticks the map may carry up to 10 000 expired entries plus 10 000 fresh evictable ones. Remediation: `evict-oldest-when-at-cap` should also apply when writing to an expired slot — cheap fix, matches the intent of `RATE_LIMIT_MAP_MAX`. Alternatively: drop expired entries in `runCleanup` more frequently than 1 hour (5 min would suffice).

### A2-662 — High — Five routes in `app.ts` missing from `openapi.ts`

`apps/backend/src/openapi.ts` does not register: `POST /api/auth/social/google` (app.ts:754), `POST /api/auth/social/apple` (app.ts:755), `POST /api/orders/loop` (app.ts:805), `GET /api/orders/loop` (app.ts:809), `GET /api/orders/loop/:id` (app.ts:814). Generated OpenAPI consumers (editor plugins, `openapi-generator` clients, the fuzzer in Phase 7) won't see these endpoints — social login and every Loop-native order flow are invisible from the public contract. Remediation: register each with the full request body / response shape / rate-limit / status-code coverage. Admin-surface gaps are in scope for Phase 5a.

### A2-663 — Low — `/api/merchants/{id}` openapi registration missing 400 + 401

`apps/backend/src/openapi.ts:1716–1730`. Handler emits 400 on `!/^[\w-]+$/` (handler.ts:142–144) and the route is behind `requireAuth` (app.ts:692) which 401s on missing bearer. Neither is documented. Remediation: add both response entries.

### A2-664 — Medium — `/api/merchants/cashback-rates` can emit 500 but openapi docs only 200 + 429

`apps/backend/src/openapi.ts:1731–1757`; handler at `merchants/handler.ts:210–229` has no try/catch — a DB outage bubbles to `app.onError` and returns 500. This endpoint is **public-ish** (hit by every catalog-list page render) and the openapi docs lie-by-omission. Remediation: either wrap in try/catch + fallback to empty `rates: {}` + `Cache-Control: public, max-age=60` (same pattern as the other never-soft endpoints), OR document 500 in the openapi entry. The former is preferable — an unauthenticated catalog render shouldn't 500 because of transient DB trouble.

### A2-665 — Medium — `/api/merchants/{merchantId}/cashback-rate` can emit 500 but openapi docs doesn't list it

`apps/backend/src/openapi.ts:1759–1800`; handler at `merchants/handler.ts:244–272`. Same pattern as A2-664 — DB throw becomes uncaught 500 and 500 is undocumented. Fix with the same soft-fallback or documentation.

### A2-666 — Low — `/api/image` can emit 500 but openapi docs doesn't list it

`apps/backend/src/openapi.ts` /api/image entry; handler `images/proxy.ts:167–170` emits `{code:'INTERNAL_ERROR'}` + 500 on any unhandled throw. OpenAPI lists 200/400/413/429/502. Remediation: add 500 to the response map, or wrap the whole handler in a belt-and-braces fallback that returns 502 instead of 500.

### A2-667 — Low — `/health` "probe flap" race between in-flight coalesce and cache TTL

`apps/backend/src/app.ts:535–568`. The in-flight coalesce (L543) short-circuits to the outstanding promise; the cache check (L537) and the in-flight check (L543) are separated by an `await`-free block so JS's single-threadedness makes this correct. BUT: the first caller sets `upstreamProbeInFlight` to the IIFE (L545), and inside the IIFE, on completion, sets `upstreamProbeCache` and resets in-flight to null (L563–564). A burst of callers between the in-flight promise resolving and the cache being read on the next call can see `upstreamProbeCache = {reachable, at}` but with `at` slightly older than the current tick. Harmless today — just a few ms staleness. Recording as informational.

### A2-668 — Info — openapi.ts documents the API but does not version it

`apps/backend/src/openapi.ts` — no `info.version` bump strategy documented. The spec is regenerated at module load time (app.ts:448). No `/openapi.json?version=<sha>` etag or cache-busting on contract changes. Consumers that cache the spec (editor plugins) won't auto-refresh. Informational — pre-launch this is fine, post-launch document a version-bump policy.

### A2-669 — Low — `refreshMerchantsInternal` uses a plain boolean lock; admin `forceRefreshMerchants` + background tick can double-start

`apps/backend/src/merchants/sync.ts:131–222`. `isMerchantRefreshing` is a boolean, not a promise. If the background timer's call is in flight when an admin forces a refresh, the admin call returns `{triggered: false}` and throws nothing — the admin sees a "nothing happened" response even though the background sweep is mid-flight. The admin handler then surfaces no follow-up information (no `refreshInProgressSince: <ts>` hint). Locations store has the same pattern (data-store.ts:72). Remediation: replace the boolean with the in-flight promise and return it to coalescing callers — admins then await the real sweep.

### A2-670 — Medium — DB throws in bulk/detail merchants endpoints become 500 instead of graceful empty

`apps/backend/src/merchants/handler.ts:210–229` and `:244–272`. See A2-664 and A2-665 for the openapi angle; the root issue is that these are catalog-page-facing reads with no never-500 fallback. Remediation: wrap in try/catch, log, and return empty `rates: {}` / `null` with `Cache-Control: public, max-age=60` — the same pattern the `/api/public/*` family uses.

### A2-671 — Low — `merchantDetailHandler` `as` casts the context bearer without runtime validation

`apps/backend/src/merchants/handler.ts:155–156`:

```ts
const bearer = c.get('bearerToken') as string | undefined;
const clientId = c.get('clientId') as string | undefined;
```

`c.get()` returns `unknown` from Hono's typed-contexts API unless declared via the `Variables` type parameter on `new Hono()`. The backend creates `const app = new Hono();` (app.ts:152) without a typed `Variables`. If `requireAuth` ever fails to set one or the other (a bug regression), `merchantDetailHandler` would pass `undefined` as `Bearer undefined` and the upstream would log an auth failure — diagnosable but ugly. Remediation: declare a typed Hono variables generic so `c.get('bearerToken')` is type-checked across handlers.

### A2-672 — High — Image proxy retains a documented DNS-rebinding TOCTOU hole

`apps/backend/src/images/proxy.ts:233–242` comment: "KNOWN LIMITATION — DNS rebinding TOCTOU. We validate the resolved IPs here, but `fetch()` below performs its own DNS lookup that we do not control." The suggested fix in the comment (custom undici `dispatcher.connect` reusing the already-resolved IP with the expected `Host` header) has not been applied. `env.ts` boot-refuses unset `IMAGE_PROXY_ALLOWED_HOSTS` in production — but dev / staging / any deployment with the emergency override flag is exposed. Even in prod, if an allowlisted host's authoritative DNS is compromised, the attacker can resolve to a private metadata IP during fetch. Remediation: implement the `dispatcher.connect` fix OR configure undici to require the same IP the validator saw. This is Phase 1 pre-launch, so window is small, but this is the one SSRF-class defect that hasn't closed.

### A2-673 — Low — Image cache `totalCacheBytes` can drift negative on concurrent insert / evict

`apps/backend/src/images/proxy.ts:29–39` + L152–159. The LRU eviction walks a sorted snapshot of entries. Because `imageProxyHandler` is async and can yield between `evictLruUntilFits(output.byteLength)` (L151) and `cache.set(...)` / `totalCacheBytes += output.byteLength` (L152–159), two concurrent requests for the same (url, w, h, q) key can each evict a victim and each add their bytes — the second one overwrites the first's cache entry, and the `totalCacheBytes` accumulator gains one byte-count while losing only one (because `cache.set` is by-key). Over time `totalCacheBytes` becomes unreliable and the cap can be exceeded by a bounded amount. Low severity (no memory leak — the Map itself is key-bounded), but the accountancy is off. Remediation: take a narrow critical section — compute key, check cache, if miss do the fetch+encode, re-check cache, insert only if still missing.

### A2-674 — Low — Discord webhook env vars accept non-https URLs

`apps/backend/src/env.ts:101–107` declares `DISCORD_WEBHOOK_*` as `z.string().url().optional()`. `z.string().url()` accepts any RFC-3986 URL including `ftp://`, `file://`, `javascript:`. Discord webhooks are always `https://discord.com/api/webhooks/…` (or the canary / ptb variants), so anything else is a misconfiguration. Compare `GIFT_CARD_API_BASE_URL` (env.ts:52–57) which has an explicit protocol refine. Remediation: add the same refine to the three Discord vars + `SENTRY_DSN`.

### A2-675 — Info — `PublicCashbackStats` / `PublicFlywheelStats` / `PublicMerchantDetail` openapi registrations live in `openapi.ts` but the shared types live in `@loop/shared`

`apps/backend/src/openapi.ts` uses `z.object({ … })` to re-declare the structure matching `@loop/shared` types. The single source of truth rule (ADR 019) is respected at the TypeScript level (handlers import from `@loop/shared`) but the OpenAPI shape is hand-authored — drift is possible. Informational: consider `zod`→`@loop/shared` codegen to pin parity.

### A2-676 — Medium — `PublicCashbackPreview` interface duplicated between backend and web instead of living in `@loop/shared`

`apps/backend/src/public/cashback-preview.ts:58–69` declares the interface. `apps/web/app/services/public-stats.ts:65–77` declares a near-identical one. ADR 019 (`docs/adr/019-shared-package-policy.md`) mandates every client-visible response shape live in `@loop/shared`. The other public shapes (`PublicCashbackStats`, `PublicTopCashbackMerchantsResponse`, `PublicMerchantDetail`) correctly live in shared — this one slipped. Remediation: move `PublicCashbackPreview` (+ `PublicLoopAsset`/`PublicLoopAssetsResponse` on a drive-by scan) into `@loop/shared`, re-export from both ends.

### A2-677 — Low — `publicMerchantHandler` fallback bootstrap emits a fresh `asOf` even though the data is stale

`apps/backend/src/public/merchant.ts:127–134`. When DB is down AND there's no prior `lastKnownGood` entry for this merchant, the handler serves `{ …catalogRow, userCashbackPct: null, asOf: new Date().toISOString() }` — the `asOf` is right-now but the cashback-pct data is bootstrap-zero, not live. Consumers caching on `asOf` think they have fresh data. Remediation: emit a sentinel `asOf: '1970-01-01T00:00:00.000Z'` on bootstrap or use the catalog's `loadedAt` (which is the actual age of the data) as the `asOf`.

---

## 8. Evidence artefacts

All findings traceable to file:line citations above. Supporting shell commands re-runnable from the repo root:

- Route drift (§5): `grep -oE "'/api/[^']+'" apps/backend/src/app.ts | sort -u` vs `grep -E "^  path: '/" apps/backend/src/openapi.ts | sed -E "s/^  path: '([^']+)'.*/\1/" | sed -E 's/\{([^}]+)\}/:\1/g' | sort -u`.
- Env parity (§4): `grep -rhoE "\benv\.[A-Z_][A-Z0-9_]+" apps/backend/src --include='*.ts' | sed 's/env\.//g' | sort -u` vs `grep -oE "^  [A-Z_][A-Z0-9_]+:" apps/backend/src/env.ts | sed 's/[ :]//g' | sort -u`.
- Discord catalog (§3): 15 `export function notify*` at discord.ts vs 15 `name: 'notify*'` entries under `DISCORD_NOTIFIERS` — parity.
- Logger redaction (§6): zod schema keys ↔ REDACT_PATHS compare.

No primary source file was modified. No tracker edits. No commits.
