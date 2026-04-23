# Phase 13 — Observability

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 13)
**Scope:** observability as a _system_ — structured access + application logs, Sentry (backend + web), Discord notifier catalog + PII scrub coverage, request-ID propagation across the CTX boundary, in-process metrics, `/health` flap-damping code path, log retention/egress, frontend error reporting, RUM, SLI/SLO surface.

**Out of scope / already covered (do not re-audit):** per-file disposition of `logger.ts` (phase-5d §6, A2-655), `discord.ts` (phase-5d §3, A2-656–A2-658), `/health` middleware slot (phase-5d §1). Cross-references called out rather than duplicated.

Primary evidence: direct file reads, line-numbered greps, and shell-assembled counts under `apps/backend/src/**` and `apps/web/app/**`.

---

## 1. Access + application logging — systemic view

### 1.1 Access log

`apps/backend/src/app.ts:350–366` — one Pino child logger `{component:'access'}` registered via `app.use('*', …)`. Emits `{method, path, status, durationMs, requestId}` after `next()` so `c.res.status` is populated. `requestId` pulled from `c.get('requestId')` (set by `hono/request-id` middleware registered one line above at `:339`) with a fallback to the inbound `X-Request-Id` header — verified: every response therefore carries an id. Tests `apps/backend/src/__tests__/routes.integration.test.ts:463–466` confirm the header round-trips on every request.

Redaction list shared with application logs via `logger.child` (single `basePinoOptions.redact` in `logger.ts:83–87`). Access-log fields are PII-minimal by construction — method / path / status / duration / request-id — so no additional redact-audit is required _on this one line_.

Noted but not re-filed: `logger.ts` REDACT_PATHS are insufficient for env-name-variant keys (phase-5d A2-655).

### 1.2 Application log classification sample

`grep -rn 'log\.(info|warn|error|debug)\(' apps/backend/src` returns 285 call sites across 115 files. `debug` appears 4 times total (`images/proxy.ts:162`, `admin/merchant-flows.ts:75`, `clustering/handler.ts:87`, `admin/user-search.ts:112`); `trace` / `fatal` are never used. `logger.child({…})` pattern is consistent — every file that logs creates a module-scoped child (117 sites matching the child pattern), with a mix of tags: `{handler: '…'}` (dominant, ~90), `{area: '…'}` (~15), `{module: '…'}` (5), `{component: 'access'}` (1), `{middleware: '…'}` (1). Tag inconsistency documented as A2-1302.

Representative 20-site classification review:

| Site                                                           | Level | Shape                                            | Classification verdict                                                                                                                            |
| -------------------------------------------------------------- | ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/handler.ts:85`                                           | error | `{status, body}` on upstream 5xx                 | correct (upstream failure)                                                                                                                        |
| `auth/handler.ts:150`                                          | error | `{status, body}` on upstream 4xx/5xx             | borderline — a 401/400 from CTX for a bad OTP is a _user_ error, classifying at `error` inflates SEV noise                                        |
| `auth/handler.ts:229`                                          | error | upstream schema drift                            | correct (invariant violation)                                                                                                                     |
| `auth/native.ts:65`                                            | warn  | `{email}` per-email OTP cap                      | correct (user-recoverable)                                                                                                                        |
| `auth/native.ts:220`                                           | warn  | refresh token not live                           | correct (user-recoverable)                                                                                                                        |
| `orders/handler.ts:141`                                        | warn  | unknown upstream status → default                | correct (defensive fallback)                                                                                                                      |
| `orders/handler.ts:222`                                        | error | upstream order creation failed                   | correct                                                                                                                                           |
| `orders/procurement.ts:258`                                    | error | CTX procurement non-ok                           | correct                                                                                                                                           |
| `orders/procurement.ts:286`                                    | info  | order fulfilled                                  | correct (domain event)                                                                                                                            |
| `orders/procurement.ts:307`                                    | warn  | operator pool unavailable                        | borderline — matches `notifyOperatorPoolExhausted` which is a monitoring-channel page. Should be `error` to align with the alerting tier. A2-1303 |
| `orders/procurement.ts:391`                                    | warn  | swept stuck procuring orders                     | correct                                                                                                                                           |
| `orders/loop-handler.ts:163`                                   | warn  | loop-auth userId with no users row               | borderline — represents a broken invariant (valid JWT for non-existent user). Should be `error`. A2-1303                                          |
| `orders/loop-handler.ts:228`                                   | error | `LOOP_STELLAR_DEPOSIT_ADDRESS` unset             | correct (config error)                                                                                                                            |
| `payments/payout-worker.ts:186`                                | error | payout marked failed                             | correct                                                                                                                                           |
| `payments/payout-worker.ts:202`                                | error | unclassified payout error                        | correct                                                                                                                                           |
| `payments/watcher.ts:85`                                       | error | unparseable payment amount                       | correct                                                                                                                                           |
| `payments/watcher.ts:126`                                      | warn  | USDC FX oracle unavailable — rejecting           | correct (transient user-visible)                                                                                                                  |
| `users/handler.ts:112,145,223,292,337,421,516,579,623,677,741` | error | 11× identical `"Failed to resolve calling user"` | see A2-1304                                                                                                                                       |
| `ctx/operator-pool.ts:84`                                      | info  | `CTX_OPERATOR_POOL is unset — pool is inert`     | inconsistent — in production where procurement is expected to work, this is a boot-time misconfig and should be `warn` / `error`. A2-1303         |
| `images/proxy.ts:168`                                          | error | image proxy error                                | correct                                                                                                                                           |

Consistency verdict: the error/warn/info split is roughly right, but there are ~4–6 sites where the level does not match the severity of the condition (captured in A2-1303). The 11 identical `"Failed to resolve calling user"` error lines in `users/handler.ts` are all the same stanza copy-pasted into 11 handlers — each logs at `error`, none tag the handler-specific context (no merchant id, order id, etc.). A2-1304.

### 1.3 Logger child pattern

`logger.child({…})` is used consistently as a module-scoped binding (117 of 117 logger users create one). Tag key is inconsistent across files — three different conventions in use (`handler` / `area` / `module`), plus `{component: 'access'}` and `{middleware: 'requireAdmin'}`. No lint rule. A2-1302.

### 1.4 Request-ID propagation across the CTX boundary

`requestId()` middleware (`hono/request-id`) generates an id per incoming request and echoes it on the response header. It is **not** forwarded on outbound CTX calls. Evidence:

- `apps/backend/src/auth/handler.ts:69–78, 126–136, 279–289` — `fetch(upstreamUrl('/login'|'/verify-email'|'/logout'), { headers: { 'Content-Type': … } … })` — no `X-Request-Id` header set.
- `apps/backend/src/merchants/handler.ts:161–170` — same shape, no id forwarded.
- `apps/backend/src/orders/handler.ts:198–215` — bearer + Content-Type only.
- `apps/backend/src/ctx/operator-pool.ts:156–201` — `operatorFetch` merges caller headers with an operator bearer; it never adds `X-Request-Id`, and no caller passes one.
- `apps/backend/src/orders/procurement.ts:76, 243` — calls `operatorFetch` with only `Content-Type` (L243) / no headers (L76).
- `grep -n "'X-Request-Id'" apps/backend/src` returns only the _inbound_ read sites in `app.ts`, `openapi.ts`, and the integration test.

Conversely, the backend does not surface the upstream CTX request id back to the client. No `res.headers.get('X-Request-Id')` or equivalent read appears in any proxy handler. A2-1305.

Impact: correlating a customer ticket ("my OTP failed — here's request id `abc123`") with the CTX ops team requires wall-clock fishing. The id already exists and is already on the outer response — forwarding it on the outbound fetch + echoing any upstream-returned id on our response closes the loop.

### 1.5 500 response includes the request id

`apps/backend/src/app.ts:1529–1536` — `app.onError` emits `{code: 'INTERNAL_ERROR', requestId}` in the body. Good: a client who hits an unexpected 500 can quote a single identifier for support.

### 1.6 Upstream body logged at 500-char cap

Eleven sites slice upstream response bodies to 500 chars before logging (grep above). Cap is correct (pino `fast-redact` cannot scrub tokens inside a string body). But the raw cap still lets anything up to 500 bytes through — in practice CTX can and does return error payloads containing user email / card numbers for validation failures. No redact-on-body pass. A2-1306.

---

## 2. Sentry config matrix

| Property                      | Backend (`app.ts:154–163`, `index.ts:113`)                                                                                                                                                                 | Web (`root.tsx:37–45`, `ErrorBoundary:461–468`, `ClusterMap:143–146`)                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Init gated on env var?        | `env.SENTRY_DSN` truthy                                                                                                                                                                                    | `import.meta.env.VITE_SENTRY_DSN` truthy AND `typeof window !== 'undefined'`                                                             |
| Environment tag               | `env.NODE_ENV` (`development` / `production` / `test`)                                                                                                                                                     | `import.meta.env.MODE` (Vite's mode, not a Loop-specific env)                                                                            |
| Release tag                   | **unset** — no `release: …` option passed                                                                                                                                                                  | **unset**                                                                                                                                |
| Sample rate                   | `tracesSampleRate: 0.1` prod / `1.0` dev                                                                                                                                                                   | `tracesSampleRate: 0.1` prod / `1.0` dev                                                                                                 |
| Performance integration       | implicit via `sentry()` middleware                                                                                                                                                                         | `Sentry.browserTracingIntegration()`                                                                                                     |
| Replay integration            | none                                                                                                                                                                                                       | none                                                                                                                                     |
| `beforeSend` redaction        | **not configured**                                                                                                                                                                                         | **not configured**                                                                                                                       |
| `sendDefaultPii`              | default (`false` — relies on Sentry SDK default)                                                                                                                                                           | default                                                                                                                                  |
| Scope enrichment              | none — no `setUser` / `setTag` / `isolationScope` anywhere                                                                                                                                                 | none — only per-event `tags: { area: '…' }` in `ClusterMap.tsx:144`                                                                      |
| `captureException` call sites | 1 (`app.ts:1530` — catch-all 500)                                                                                                                                                                          | 2 (`root.tsx:467` ErrorBoundary, `ClusterMap:143` on cluster fetch err)                                                                  |
| Shutdown flush                | `sentryFlush(5000)` in `index.ts:113`                                                                                                                                                                      | n/a (browser)                                                                                                                            |
| Source-map upload             | build emits sourcemaps (`tsup.config.ts:9 sourcemap: true`) but no `@sentry/vite-plugin` / `@sentry/webpack-plugin` / `sentry-cli` step to upload them → symbolication on the Sentry side will be minified | web vite build does not set `build.sourcemap` at all (default: `false` for prod) → minified frames _and_ no source maps shipped. A2-1307 |
| DSN redaction in logger       | **no** — phase-5d A2-655 — DSN-bearing env name not in REDACT_PATHS                                                                                                                                        | n/a (DSN baked into bundle is public by design for browser SDKs)                                                                         |

Findings:

- **No `beforeSend` / `beforeSendTransaction` handler on either side.** Authorization headers, OTP codes, refresh tokens, idempotency keys, admin audit-trail values, and Stellar operator secret material are not stripped before the event leaves the process. Pino `REDACT_PATHS` does not apply to Sentry events — Sentry's SDK has its own default PII scrubber, but it only covers a small fixed set (`password`, `token`, `secret` keyword-match on top-level keys in breadcrumbs). Backend `app.onError` capture will include the full `err.message` / `err.cause` chain verbatim, and on a handler that threw after reading a bearer, the stack frames include local-variable values from V8 when `captureContext.exception.values[].stacktrace.frames[].vars` is populated (SDK default: off on server, but on in browser for some frameworks). A2-1308 — High.
- **No `release: …` tag** means every event lands in the `latest` release bucket on Sentry. A2-1309 — Medium.
- **`environment` mapping is different between backend (`NODE_ENV`) and web (`import.meta.env.MODE`).** Staging deploys on both sides that set `NODE_ENV=production` plus a custom `VITE_STAGING=1` will bucket web events as `production` alongside real prod — events from the two deploys mix. A2-1310 — Medium.
- **`tracesSampleRate: 0.1` at prod volume will be noisy-and-expensive before a baseline is known.** Pre-launch this is fine; but `errorSampleRate` / `profilesSampleRate` / `replaysOnErrorSampleRate` are all SDK defaults (1.0 / 0 / 0). No error-sampling policy is documented. A2-1311 — Info.
- **Client-side Sentry has one `captureException` at `ClusterMap.tsx:143` that ships `extra: { params }`.** `params` contains the map viewport (`latMin`, `latMax`, `lngMin`, `lngMax`, `zoom`) — not PII, but worth noting that it's the only place in the web that adds anything beyond the error itself. `ErrorBoundary` at `root.tsx:467` captures the raw error — which, on a React Router loader error that includes a fetch response body (we do this in several loaders), may include the full JSON payload as `error.cause`. A2-1312 — Medium.

---

## 3. Discord notifier × PII audit

Cross-reference to phase-5d §3 which enumerated all 15 notifiers with call sites. Expanded here with a dedicated PII-coverage column using the full argument list actually passed at each call site.

| #   | Notifier                      | Channel           | Call site(s) (file:line)                                            | Args passed                                                                                                 | PII in embed text                                                                                                                           | Scrub verdict                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------- | ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `notifyOrderCreated`          | orders            | `orders/handler.ts:306`                                             | orderId, merchantName, amount, currency, xlmAmount                                                          | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 2   | `notifyCashbackRecycled`      | orders            | `orders/loop-handler.ts:302`                                        | orderId, merchantName, amount, currency, assetCode                                                          | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 3   | `notifyFirstCashbackRecycled` | orders            | `orders/loop-handler.ts:313`                                        | orderId, userId, userEmail, merchantName, amount, currency, assetCode                                       | **full user email** at `discord.ts:195` — escapeMarkdown'd, truncated to 1024, but not hashed/masked                                        | A2-1313 — Medium: orders channel is broader than admin-audit; see rationale below                                                                                                                                                                                                              |
| 4   | `notifyOrderFulfilled`        | orders            | `orders/handler.ts:577`                                             | orderId, merchantName, amount, currency, redeemType                                                         | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 5   | `notifyCashbackCredited`      | orders            | `orders/procurement.ts:296`                                         | orderId, merchantName, amountMinor, currency, userId                                                        | userId first-8 (A2-657 dupe — phase-5d filed)                                                                                               | clean enough; inconsistent                                                                                                                                                                                                                                                                     |
| 6   | `notifyHealthChange`          | monitoring        | `app.ts:532` (via `maybeNotifyHealthChange`)                        | status, details (fixed template)                                                                            | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 7   | `notifyPayoutFailed`          | monitoring        | `payments/payout-worker.ts:187, 203`                                | payoutId, userId, orderId, assetCode, amount, kind, reason, attempts                                        | full userId + orderId + payoutId; reason is a server-generated string (PayoutSubmitError kind)                                              | A2-1314 — Medium: full userId rather than last-8; reason may echo Horizon error which can include a destination address (Stellar pubkey) — not PII per ADR-006 but linkable                                                                                                                    |
| 8   | `notifyUsdcBelowFloor`        | monitoring        | `orders/procurement.ts:234`                                         | balanceStroops, floorStroops, account                                                                       | account pubkey                                                                                                                              | clean (operator account is ops data)                                                                                                                                                                                                                                                           |
| 9   | `notifyAdminAudit`            | admin-audit       | `admin/credit-adjustments.ts:119, 197`, `admin/payouts.ts:293, 346` | actorUserId, actorEmail, endpoint, targetUserId?, amountMinor?, currency?, reason, idempotencyKey, replayed | **full actorEmail** + last-8 of actorUserId + last-8 of targetUserId; full idempotencyKey truncated to 32 chars                             | A2-1315 — Medium: admin-audit channel by convention has fewer readers than orders, but "admin email in Discord" is still PII-in-chat                                                                                                                                                           |
| 10  | `notifyCashbackConfigChanged` | admin-audit       | `admin/handler.ts:109`                                              | merchantId, merchantName, actorUserId, previous, next                                                       | last-8 of actorUserId only; no email                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 11  | `notifyAssetDrift`            | monitoring        | `payments/asset-drift-watcher.ts:156`                               | assetCode, driftStroops, thresholdStroops, onChainStroops, ledgerLiabilityMinor                             | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 12  | `notifyAssetDriftRecovered`   | monitoring        | `payments/asset-drift-watcher.ts:165`                               | assetCode, driftStroops, thresholdStroops                                                                   | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 13  | `notifyOperatorPoolExhausted` | monitoring        | `ctx/operator-pool.ts:198`                                          | poolSize, reason                                                                                            | reason is truncated upstream error message — 500-char slice NOT applied here (caller passes `err.message` raw at L189 → `reason` in notify) | A2-1316 — Low: upstream error string can be >1024 chars; `truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX)` at `discord.ts:591` catches display but the webhook body can still include pre-truncation content in field metadata if Discord ever changes parsing. (Defense-in-depth nit.) |
| 14  | `notifyCircuitBreaker`        | monitoring        | `circuit-breaker.ts:90, 107`                                        | state, consecutiveFailures, cooldownSeconds                                                                 | none                                                                                                                                        | clean                                                                                                                                                                                                                                                                                          |
| 15  | `notifyWebhookPing`           | any (channel arg) | `admin/discord-test.ts:71`                                          | channel, actorId                                                                                            | actorId first-8                                                                                                                             | clean                                                                                                                                                                                                                                                                                          |

**Aggregate PII findings:**

- **`notifyFirstCashbackRecycled` leaks a full user email to the `orders` Discord channel** (`discord.ts:195`). Phase-5d called this "admins-only channel, acceptable" but that's not documented policy anywhere — the orders channel receives five notifiers including two that fire on _every_ order (OrderCreated / OrderFulfilled). The implicit policy that "whoever reads orders also sees user emails" conflates two roles. In a team-of-one pre-launch this is fine; post-launch, the moment a second team member is added to the orders channel, the email exposure widens silently. A2-1313.
- **`notifyAdminAudit` leaks full admin email** (`discord.ts:407`) into the admin-audit channel. Same pattern. Less severe because the admin-audit channel readership maps 1:1 to admin users who already see each other's identities in the admin panel. A2-1315.
- **`notifyPayoutFailed` uses full userId + orderId + payoutId** (`discord.ts:346–348`). The other notifiers truncate user identifiers to last-8; this one is the exception. Rationale (implicit): monitoring-channel readers need to paste the id into an admin panel URL without guessing the remaining chars. Acceptable but inconsistent with the ADR-018 convention that `notifyAdminAudit` explicitly truncates. A2-1314.

No notifier leaks an OTP, refresh token, access token, Stellar secret, JWT signing key, Sentry DSN, Discord webhook URL, or gift-card activation code. `sendWebhook` at `discord.ts:34–68` is the single egress funnel — every embed goes through it, `allowed_mentions: { parse: [] }` suppresses @everyone / @here, and 5 s `AbortSignal.timeout` bounds the wait.

### 3.1 Catalog parity

Re-verified: `grep -c "^export function notify" discord.ts` = 15; catalog entries = 15. Matches phase-5d. Ordering bug A2-656 already filed.

---

## 4. `/health` flap-damping code-path walk (PR #752 verification)

`apps/backend/src/app.ts:482–640`. State:

```
HEALTH_FLIP_TO_DEGRADED_STREAK = 2                       (L489)
HEALTH_FLIP_TO_HEALTHY_STREAK  = 3                       (L490)
HEALTH_NOTIFY_COOLDOWN_MS      = 5 * 60 * 1000           (L500)
UPSTREAM_PROBE_TTL_MS          = 10_000                  (L510)
UPSTREAM_PROBE_TIMEOUT_MS      = 5_000                   (L516)
```

Per-request flow (L570–640):

1. `getLocations()` + `getMerchants()` → compute `merchantsStale`, `locationsStale` vs 2× refresh interval (`env.REFRESH_INTERVAL_HOURS`, `env.LOCATION_REFRESH_INTERVAL_HOURS`).
2. `upstreamReachable = await probeUpstream()` — 10 s TTL cache + in-flight coalesce (L537, L543).
3. `rawReading = 'degraded' | 'healthy'` from `merchantsStale || locationsStale || !upstreamReachable` (L583).
4. Streak accounting (L591–597):
   - degraded reading: `degradedReadingStreak++; healthyReadingStreak = 0`
   - healthy reading: `healthyReadingStreak++; degradedReadingStreak = 0`
5. Transition logic (L602–621) — asymmetric by design:
   - First-ever hit (`lastHealthStatus === null`): latches `rawReading` without notifying (L602–603).
   - `healthy → degraded`: requires `degradedReadingStreak >= 2` (L605–607). Then flip + `maybeNotifyHealthChange('degraded', …)`.
   - `degraded → healthy`: requires `healthyReadingStreak >= 3` (L614–617). Then flip + `maybeNotifyHealthChange('healthy', 'All systems operational')`.
6. `maybeNotifyHealthChange` (L528–533) — second layer: if `now - lastHealthNotifyAt < 5 min`, drop the notify silently. Cooldown applies to _both_ directions.
7. Response: `Cache-Control: no-store` (L628), then JSON body reflects `rawReading`-equivalent (`status: degraded ? 'degraded' : 'healthy'` — note: this is the raw per-probe reading, NOT `lastHealthStatus`; the external-facing status is the un-flapped reading, not the streak-gated one). **This is a subtle asymmetry worth recording.** The Discord notify is gated by the streak; the HTTP response is not. A2-1317 — Info: document it, either in the handler comment or in `/health` OpenAPI response description. Fly.io health probe keys on HTTP status + 200-OK body shape, not on a `status: healthy` string, so operationally this is safe. But a human debugging "why did the channel not page?" needs to know the two paths diverge.

2/3 asymmetry rationale (captured in the code comment at L485–488): into-degraded fast (~30 s at 15 s Fly probe + 10 s cache), out-of-degraded slow to avoid flapping-healthy on a marginal upstream. Evidence of rationale: comment at L486–488. This matches the audit plan's G4-19 expectation. The streak counters have test seams — `__resetHealthProbeCacheForTests` at L224–231 resets _everything_ (streak + cache + notify cooldown); `__resetUpstreamProbeCacheOnlyForTests` at L239–242 preserves the streak state for flap-damping tests. I verified by grep that the test file `routes.integration.test.ts` uses both seams in different cases (not re-audited; phase-14 scope).

Bootstrap behaviour (L602–603): first `/health` on a fresh process latches silently — no page on boot. Good: without it, Fly re-rolling a healthy machine would notify every deploy.

Restart loses state: if the process restarts mid-outage, the first `/health` call re-latches to `degraded` silently, no page. Next flap produces a fresh notify. Correct — the comment at `discord.ts:520–523` for `notifyAssetDrift` explains the same pattern. Aligned.

---

## 5. Metrics — in-process counters

`apps/backend/src/app.ts:370–441`. Three metrics:

- `loop_rate_limit_hits_total` — counter, single-scalar (L406–408).
- `loop_requests_total{method, route, status}` — counter, labelled by `method:route:status` (L411–417). Route-path normalised: unmatched routes collapse to `NOT_FOUND` (A-022 closed, L388–398 comment).
- `loop_circuit_state{endpoint}` — gauge 0/1/2 (L425–432) derived from `getAllCircuitStates()`.

`GET /metrics` emits Prometheus 0.0.4 text format. `Cache-Control: no-store` (L439). **No auth gate, no rate limit** (phase-5d A2-660 already filed). No external collector is configured anywhere — `grep 'prometheus\|otel\|opentelemetry\|exporter'` returns only the `/metrics` handler itself, the README for the endpoint, the openapi registration at `openapi.ts:1544`, and comments. No `prom-client`, no OpenTelemetry exporter, no StatsD. Observability depth finding:

- **Counters are emitted only to `/metrics` — no scraper is configured in either `fly.toml`.** `apps/backend/fly.toml` has no `[metrics]` block, no Prometheus sidecar, no `[[services.ports]]` metric port. The endpoint is scrapeable _if someone runs a Prometheus_, but nothing in the deploy stands up a Prometheus. Effect: the counters are write-only until ops reaches `fly ssh` and `curl /metrics`. A2-1318 — Medium.
- **Process-local, lost on restart.** Any deploy zeros the counters. Without persistence / aggregation this makes the data a point-in-time sample, not a time series. A2-1318 (same finding).

Additional missing counters, relative to the alerting surfaces:

- No `loop_discord_webhook_failures_total` — `discord.ts:56–67` logs a warn on non-success / catch, but never increments a metric. Ops sees "we tried to page" in logs only. A2-1319 — Low.
- No `loop_max_pages_cap_hit_total` — `clustering/data-store.ts:165–167` + `merchants/sync.ts:186–187` log-only (phase-5d A2-659 filed at the notification level; this is the metric variant).
- No `loop_upstream_fetch_latency_seconds` — every CTX proxy call is a black box on the Prometheus side. Sentry transactions capture some of this but are sampled at 10 %.

---

## 6. Log retention / egress (G4-11, G5-91)

`apps/backend/fly.toml` has no `[log_shipping]` / `[monitor]` / `[files]` block and no mention of log retention. Backend stdout goes to Fly's platform log buffer.

Per Fly.io defaults (not in repo): platform logs are retained ~7 days on the free tier, ~30 days on paid orgs, accessible via `fly logs` to anyone with deploy access on the `loopfinance-api` app. No log-shipping to Axiom / Datadog / Loki / Papertrail is configured. No `LOG_LEVEL` override documented as a runbook step.

Consequences:

- **Retention is "whatever Fly gives us" and is unowned.** `docs/deployment.md:99` mentions `fly logs` as the debug command, full stop. No ADR describes retention or egress. A2-1320 — High (G4-11). Post-launch, a security incident three weeks after the fact has no logs. A customer dispute about a payout 45 days ago has no logs.
- **No log sampling policy.** Access log emits one line per request; at steady state of even a few RPS this is the dominant volume. Fly logs do not sample. Healthcheck `GET /health` at 15 s Fly probe + an unknown number of external / Capacitor pings produces ≥ 5,760 lines/day even on an idle deploy. A2-1321 — Medium (G5-91): exempt `/health`, `/metrics`, `/openapi.json` from access-log output, or down-sample to 1-in-N.
- **No access-control review of who reads logs.** Any Fly org member with access to the app can `fly logs`. PII (user emails in `notifyFirstCashbackRecycled`-style events, error-path email fields in `auth/handler.ts:85, 150` truncated-body logs, idempotency keys, target user ids in the access log's `path` field) is in those logs. Phase-1 governance covered repo access; the log-read surface is separate. A2-1320 (aggregated).

---

## 7. Frontend error reporting (G5-92)

`apps/web/app/root.tsx:37–45`:

- Init gated on `typeof window !== 'undefined' && import.meta.env.VITE_SENTRY_DSN`. SSR pages therefore never init Sentry — loader errors on the SSR pass land in the Hono backend Sentry if they propagate (they don't — React Router error boundaries catch first).
- `tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0`.
- Integrations: `browserTracingIntegration()` only. No `replayIntegration`, no `captureConsoleIntegration`, no `dedupeIntegration` (SDK default includes dedupe). No `beforeSend`. No `release` set.
- No `sentry-cli` / `@sentry/vite-plugin` dependency anywhere (`grep -r "@sentry/vite-plugin"` = 0 hits). `apps/web/vite.config.ts` does not set `build.sourcemap`. → **Prod web is minified, with no source maps shipped, with no upload to Sentry.** Stack traces on Sentry will be raw minified frames (function names like `_`, `r`, `n`) — essentially unusable. A2-1307 — High (G5-92 direct hit).
- Capture sites: two. `ErrorBoundary` at `root.tsx:467` (captures every React-Router error thrown past a route boundary — may include loader `error.cause` fetch-response payloads) and `ClusterMap` at `ClusterMap.tsx:143` (intentional, tagged `area: 'map.cluster-fetch'`). No other hook / service surfaces a Sentry capture. The 50+ TanStack Query `mutation.onError` / `query.onError` paths across the services layer do not forward to Sentry. Errors that never bubble to the React error boundary (e.g. a query the UI silently handles with a retry-then-toast) never reach Sentry. A2-1322 — Medium.

No web analog to the backend's request-id correlation: the web never reads `X-Request-Id` from a backend response and never attaches it as a Sentry tag. A ticket from a user cannot be cross-referenced to backend logs via Sentry. A2-1323 — Medium.

No public auth / form input sanitation in `ErrorBoundary` — a thrown error from a login form may capture the email as part of the error context. Not confirmed by a running test but mechanically possible given React 19's error reporting.

---

## 8. RUM / Web Vitals (G5-93)

`grep -rn "web-vitals\|onLCP\|onCLS\|onINP\|onFID\|onFCP\|reportWebVitals"` across the repo returns **zero hits**. No `web-vitals` dependency in `apps/web/package.json` (verified by absence of the hit). Sentry's `browserTracingIntegration` captures some Web Vitals by default (LCP, FCP, FID, CLS, TTFB) but not INP without the optional integration, and samples at 10 % in prod — meaning for a low-volume pre-launch site the RUM data arriving in Sentry is statistically thin.

No Lighthouse CI, no budget-enforcing CI step, no public-page LCP budget documented. A2-1324 — Medium (G5-93).

---

## 9. SLI / SLO definition (G5-94)

"SLO" appears in code/docs 40+ times (grep above), **all in admin-surface route names and comments** for `stuck-orders` / `stuck-payouts`. Neither file defines an SLO number:

- `apps/backend/src/admin/stuck-orders.ts` — handler reads `?thresholdMinutes=` from the client. Default is set at the admin UI layer (`apps/web/app/routes/admin.stuck-orders.tsx`) which accepts 5 / 15 / 60. No ADR pins "orders must clear in X minutes at P99". The "SLO" is an adjustable slider.
- `apps/backend/src/admin/stuck-payouts.ts:95` comment references "past-SLO" but also without a fixed threshold.
- `docs/` has no `slo.md`, no ADR 024-SLO-definition, no section in `docs/standards.md` titled "SLO".

There is no error budget, no burn-rate alert, no availability target, no latency target, no freshness target ("merchant catalog will be ≤ N hours stale"). The health endpoint's 2× refresh interval staleness check (`app.ts:576–579`) is the closest thing — but it's a hard gate, not a budget.

A2-1325 — Medium (G5-94): admin UI uses the phrase "SLO" without the concept existing.

---

## 10. Alert fatigue / Discord volume baseline

No observed historical data (pre-launch; no production volume). Baseline reasoning from the notifier catalog:

| Notifier                                                                            | Fire frequency upper bound                                                                                    | Throttle?                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `notifyOrderCreated` / `notifyOrderFulfilled`                                       | 1 per order                                                                                                   | none — each order = 2 lines            |
| `notifyCashbackRecycled` / `notifyFirstCashbackRecycled` / `notifyCashbackCredited` | subset of orders                                                                                              | none                                   |
| `notifyHealthChange`                                                                | at most 2× per 5 min via `HEALTH_NOTIFY_COOLDOWN_MS`                                                          | 5-min cooldown                         |
| `notifyCircuitBreaker`                                                              | open/closed per upstream endpoint                                                                             | none — 7 endpoints × 2 transitions     |
| `notifyOperatorPoolExhausted`                                                       | first failure + once per 15 min thereafter (`POOL_EXHAUSTED_ALERT_INTERVAL_MS` at `ctx/operator-pool.ts:196`) | 15-min throttle                        |
| `notifyPayoutFailed`                                                                | 1 per failed payout (usually 1 per user per failure)                                                          | none                                   |
| `notifyUsdcBelowFloor`                                                              | 1 per tick under floor, callers throttle once per `LOOP_BELOW_FLOOR_ALERT_INTERVAL_MS`                        | caller-side                            |
| `notifyAssetDrift` / `notifyAssetDriftRecovered`                                    | 1 per ok→over / over→ok transition                                                                            | in-memory dedupe at watcher            |
| `notifyAdminAudit`                                                                  | 1 per admin write                                                                                             | none — but admin writes are low-volume |
| `notifyCashbackConfigChanged`                                                       | 1 per config mutation                                                                                         | none                                   |
| `notifyWebhookPing`                                                                 | on demand                                                                                                     | none                                   |

**Risk scenarios**:

- A burst of order flow (marketing campaign) produces 2× volume on `orders` channel with no throttling. Discord's own per-webhook rate limit (~30/min) will start 429-ing `sendWebhook` calls, which the code logs as warn at `discord.ts:63` and drops. No retry, no metric. A2-1319 (above).
- A flapping circuit breaker (upstream partial outage) fires `notifyCircuitBreaker` every 30 s cooldown → up to 120 embeds/hour in `monitoring`. No dedup / grouping (G5-89). A2-1326 — Medium.
- No on-call paging tier above Discord (G5-90). `HEALTH_NOTIFY_COOLDOWN_MS` prevents ops channel flood, but if Discord itself is down or the operator isn't watching Discord, no other paging channel exists. A2-1327 — Medium.

No Discord channel auto-mute / digest / snooze; no runbook for "what to do when the channel floods".

---

## 11. Findings summary

IDs A2-1300 – A2-1327 (28 used; 72 slots remain). Severities per plan §3.4. PII-in-Discord / PII-in-logs flagged individually.

### A2-1300 — Info — Phase-13 omnibus: this evidence file exists; no single aggregate finding

Placeholder for the file-level record. No action.

### A2-1301 — Info — 285 log sites / 117 logger children / 4 debug / 0 trace / 0 fatal

Baseline inventory. No action required; recorded for future drift checks.

### A2-1302 — Low — Inconsistent `logger.child` tag key — `handler` / `area` / `module` / `component` / `middleware`

`apps/backend/src/**` — 117 `logger.child({…})` sites use five different tag keys. Dominant: `{handler: '…'}` (~90 sites under handlers). Also `{area: '…'}` in long-lived workers and `{module: '…'}` in pure infra (`discord`, `circuit-breaker`, `data-store`, `merchants-sync`). This makes pino output search unpredictable — filtering "all auth logs" requires `handler=auth OR area=auth-social OR area=email OR area=id-token`. Remediation: pick one tag (most existing usage is `handler`), rename everywhere, add an ESLint rule mirroring `no-restricted-syntax` that blocks `logger.child({area:` / `logger.child({module:`.

### A2-1303 — Low — Four log sites classify misaligned with severity

`orders/procurement.ts:307` (operator pool unavailable — warn vs error; Discord pages at this condition), `orders/loop-handler.ts:163` (loop-auth userId has no users row — warn vs error; this is a broken-invariant condition, not a user-recoverable one), `ctx/operator-pool.ts:84` (pool unset — info vs warn for prod missing config), `auth/handler.ts:150` (upstream 4xx for bad OTP — error vs warn; a user typo is not an error condition). Remediation: reclassify per the rule "error = something is wrong with the server; warn = something is wrong but recoverable or user-caused; info = normal domain event".

### A2-1304 — Low — 11 identical `"Failed to resolve calling user"` error log lines in `users/handler.ts`

Lines 112, 145, 223, 292, 337, 421, 516, 579, 623, 677, 741 all log `log.error({ err }, 'Failed to resolve calling user');` — no handler name, no endpoint. In production, "which handler" has to be inferred from Pino's `{handler: 'users'}` child, which is the _file-level_ child — every one of these 11 lines comes from the same child. Remediation: add `{ err, handler: 'me' }` / `{ err, handler: 'orders-summary' }` distinguishing context at each site, OR factor the resolve-user call into a helper that logs with the caller's handler tag.

### A2-1305 — High — Request ID not propagated to upstream CTX; upstream request id not surfaced back

No outbound fetch in `apps/backend/src/auth/*.ts`, `orders/*.ts`, `merchants/*.ts`, `ctx/operator-pool.ts`, `payments/*.ts` sets an `X-Request-Id` header. `operatorFetch` (`ctx/operator-pool.ts:172`) copies caller headers and sets `Authorization`; no id injection. Conversely, no proxy handler reads CTX's response `X-Request-Id` (or any CTX correlation header) and echoes it in the Loop response. Ops cannot ask CTX "what happened to our request `abc123`?" without a timestamp dig. Remediation: in a shared `upstreamFetch` helper (or directly in `operatorFetch` + every `getUpstreamCircuit(…).fetch`), pull `c.get('requestId')` via async-context (`cls-hooked` / `AsyncLocalStorage`) and set both `X-Request-Id: <ours>` on the outbound and `X-Ctx-Request-Id: <theirs>` on our response.

### A2-1306 — Medium — Upstream response bodies logged at 500-char cap have no redact pass

11 sites slice `response.text()` to 500 chars and log it. Pino `fast-redact` is field-based — it cannot scrub inside a logged string. CTX has in practice returned error payloads that include the submitted email / card number / activation code. An operator reading the logs can see these; they ship to Sentry via `captureException` if wrapped in an Error; they ship to Fly platform logs unbounded. Remediation: add a `scrubUpstreamBody(body: string): string` helper that regex-replaces email-shaped tokens, 16+ digit sequences, and Bearer-shaped strings before logging. Apply to all 11 sites.

### A2-1307 — High — Web prod bundle has no source maps uploaded to Sentry; stack traces will be minified-unusable

`apps/web/vite.config.ts` does not set `build.sourcemap`; Vite default for production is `false`. Even if it were `true`, no `@sentry/vite-plugin` or `sentry-cli` step runs at build time to upload. Sentry events from web will arrive with frames like `_.js:1:14233` — unactionable. Remediation: add `@sentry/vite-plugin` gated on `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` env vars; set `build.sourcemap: 'hidden'` so maps are generated but not served to end users.

### A2-1308 — High — Neither Sentry SDK has `beforeSend` / `beforeSendTransaction` configured; no custom PII scrub

Backend `app.ts:156–163` and web `root.tsx:39–45` both pass only `dsn`, `environment`, `tracesSampleRate`, and (web only) `integrations`. Sentry SDK default scrubber covers a narrow keyword set and does not know about Loop-specific secrets (refresh tokens, OTP codes, idempotency keys, Stellar secrets, Loop JWT signing key). An error thrown after reading a bearer in `authenticatedHandler` will capture the full closed-over scope in the event. Remediation: implement a shared `beforeSend` in `apps/backend/src/sentry-scrubber.ts` + `apps/web/app/utils/sentry-scrubber.ts` that walks `event.request.headers`, `event.extra`, `event.contexts`, and every `event.exception.values[].stacktrace.frames[].vars` entry, redacting any key matching the REDACT_PATHS list (shared from `@loop/shared`). Register in both Sentry.init calls.

### A2-1309 — Medium — No `release` tag on either Sentry client

Neither init passes `release`. Effect: every event falls into the "latest" release bucket; cannot tell which deploy introduced a regression. Remediation: pass `release: process.env.FLY_RELEASE_VERSION ?? env.NODE_ENV` (backend) + `release: import.meta.env.VITE_GIT_SHA` (web, injected at vite build time from `git rev-parse HEAD`).

### A2-1310 — Medium — `environment` tag semantics diverge between backend and web

Backend uses `env.NODE_ENV` (`development` | `production` | `test`). Web uses `import.meta.env.MODE` (Vite's notion, typically the same but not guaranteed — e.g. `vite build --mode staging` → `staging`). A staging deploy that sets `NODE_ENV=production` and `MODE=staging` will bucket backend events as `production` and web events as `staging` — the pair is desynced. Remediation: standardise on an explicit `VITE_LOOP_ENV` + `LOOP_ENV` pair, both set at deploy, both threaded into Sentry.

### A2-1311 — Info — Sample-rate strategy is `tracesSampleRate` only

No `errorSampleRate`, no `profilesSampleRate`, no `replaysOnErrorSampleRate`, no `beforeSendTransaction` sample filter. Pre-launch this is moot; at scale, a single high-volume error can flood the Sentry quota. Remediation: document a rate-cap strategy in a future ADR.

### A2-1312 — Medium — Web `ErrorBoundary` captures raw error without context sanitisation

`root.tsx:461–468` calls `Sentry.captureException(error)` with the React Router error object. React Router loader errors include `response` objects and thrown fetch responses — if a loader throws `new Response(await res.text(), {status: 500})`, the full response body lands in Sentry. Remediation: before `captureException`, strip `error.response`, `error.cause` if it's a `Response` or `Request`, and scrub any `error.message` containing an email / bearer.

### A2-1313 — Medium — `notifyFirstCashbackRecycled` leaks full user email to `orders` Discord channel

`discord.ts:193–196`. The `orders` channel is broader than `admin-audit` (five notifiers fire there on normal order flow). Remediation: drop `userEmail` from the embed — use `userId.slice(-8)` like `notifyAdminAudit`; surface the email lookup in the admin UI where authorised viewers can resolve it.

### A2-1314 — Medium — `notifyPayoutFailed` uses full userId / orderId / payoutId; inconsistent with ADR-018 truncation convention

`discord.ts:346–348`. ADR-018 convention for admin-audit is last-8. Monitoring channel uses full ids. Remediation: either (a) truncate here to last-8 + link to admin URL built from the full id in the webhook body (Discord URL fields support full text) — same UX without leaking full ids into chat, or (b) document in ADR-018 that monitoring-channel ids are intentionally full and why.

### A2-1315 — Medium — `notifyAdminAudit` leaks full admin email to the admin-audit Discord channel

`discord.ts:407`. Channel readership IS admins, so this is less severe than A2-1313 but still leaks an identity into chat. Remediation: use `actorEmail` only for ops-readable context in the embed description, truncate to domain: `{email-local}@…` — admins can drill to the full row via the idempotency key.

### A2-1316 — Low — `notifyOperatorPoolExhausted` passes upstream `err.message` without a 500-char cap pre-truncate

`ctx/operator-pool.ts:189`: `const reason = lastErr instanceof Error ? lastErr.message : 'All operators unhealthy';` — no slice. `discord.ts:591` does `truncate(…, FIELD_VALUE_MAX)` for display, but the webhook body as POSTed includes the pre-truncation content if any future Discord API accepts metadata beyond the embed. Defense-in-depth nit. Remediation: `reason.slice(0, 500)` at the call site.

### A2-1317 — Info — `/health` HTTP response reports raw reading; Discord paging uses streak-gated status

`app.ts:629–639` returns `status: degraded ? 'degraded' : 'healthy'` where `degraded` is the per-probe raw boolean. The Discord `notifyHealthChange` only fires on `lastHealthStatus` transitions (streak-gated). So an external HTTP consumer of `/health` sees flaps; Discord sees damped events. Intentional but undocumented. Remediation: note in the handler comment, add a `rawStatus` vs `status` distinction in the response body so external probers can choose.

### A2-1318 — Medium — In-process metrics are scrape-only; no scraper configured in Fly; lost on restart

`/metrics` endpoint (`app.ts:403–441`) is correct, but no process scrapes it. `fly.toml` has no monitoring config. Every deploy zeros all counters. Remediation: either (a) add Fly's built-in Prometheus-scraping config pointing a host Grafana at the endpoint, or (b) add a push-based exporter (e.g. Axiom) with `@opentelemetry/sdk-metrics`.

### A2-1319 — Low — No metric for Discord webhook delivery failures

`discord.ts:63` logs warn on non-2xx; `discord.ts:66` logs warn on catch. No counter. In a monitoring outage (Discord itself 500ing) the rest of the system is blind to the fact that its paging channel is down. Remediation: add `metrics.discordWebhookFailuresTotal` counter + label `{channel}` + expose on `/metrics`.

### A2-1320 — High — Log retention / egress / access is unowned and undocumented (G4-11)

No log-shipping config in `fly.toml`. No ADR. No runbook. Platform logs are whatever Fly retains (~7–30 days). Anyone with Fly org deploy access can `fly logs` and read PII. A security incident or customer dispute past the retention window has no evidence. Remediation: either (a) add `@axiomhq/pino` / `@datadog/winston` transport, ship to a managed log store with documented retention + access policy, or (b) explicitly accept the Fly default in an ADR with retention-window + authorised-readers named and a note that PII will be in there.

### A2-1321 — Medium — No access-log sampling; `/health`, `/metrics`, `/openapi.json` log every hit

`app.ts:351–366` emits one access log per request with no filter. Fly probe at 15 s = 5,760 `/health` lines/day per machine. `/metrics` scraped at 15 s = another 5,760. External `/openapi.json` loads add more. Remediation: short-circuit the access-log `app.use('*')` for paths in `['/health', '/metrics', '/openapi.json']`, OR wrap in `if (Math.random() < 0.01)` sampling for these paths specifically.

### A2-1322 — Medium — TanStack Query error paths do not forward to Sentry

`apps/web/app/services/*.ts` + `app/routes/*.tsx` — 50+ `useQuery` / `useMutation` usages. Only two `Sentry.captureException` sites exist (`ErrorBoundary` + `ClusterMap`). A query error handled by `onError: toast.error(…)` silently discards the signal. For a rolled-out app this means "no one reported a bug" is indistinguishable from "we never saw the bug because we suppressed it into a toast". Remediation: add a shared `logQueryError` hook that wraps any retryable-exhausted error in a Sentry `captureException` with tags `{area: 'query', query: useQuery().queryKey[0]}` before handing to the component.

### A2-1323 — Medium — Web Sentry events have no backend request-id correlation tag

Neither the API client nor the Sentry init threads `X-Request-Id` from the response into a Sentry tag. A customer ticket with a Sentry event id cannot be pivoted to backend logs. Remediation: read `res.headers.get('X-Request-Id')` in the shared `api.ts` fetch wrapper; on error, `Sentry.setTag('requestId', id)` before the throw.

### A2-1324 — Medium — No explicit RUM / Web Vitals; `browserTracingIntegration` default coverage is thin at 10% sample

No `web-vitals` dependency, no `onLCP` / `onCLS` / `onINP`. Sentry's browser tracing captures LCP/FCP/FID/CLS at `tracesSampleRate`, which is 10 % in prod. INP (React 19 focus metric) is not captured by default. No Lighthouse budget in CI. Remediation: add `web-vitals` + ship metrics at a higher rate than tracing (LCP/CLS/INP are sparse, should be 100 %).

### A2-1325 — Medium — "SLO" is used in admin route names and comments but no SLO is defined anywhere

`admin/stuck-orders.ts`, `admin/stuck-payouts.ts`, plus 40+ doc / route mentions. Threshold is an admin-UI slider, not a committed target. No error budget, no burn rate, no availability target, no latency target, no catalog-freshness SLO. Remediation: add `docs/adr/024-service-level-objectives.md` committing to target numbers for (a) `/api/public/*` availability, (b) order fulfillment P99 time, (c) payout submit P99 time, (d) merchant catalog max staleness, (e) error-budget burn alerting.

### A2-1326 — Medium — No Discord alert dedup / grouping; circuit-flap floods `monitoring` (G5-89)

`notifyCircuitBreaker` fires on every open/closed transition across 7 upstream endpoints. A flapping upstream at 30 s cooldown can emit 120 embeds/hour into `monitoring`. No per-endpoint throttle. Remediation: add a `lastNotifyByKey: Map<string, number>` throttle keyed on `${endpoint}:${state}` with a 5-min minimum gap, mirroring the `POOL_EXHAUSTED_ALERT_INTERVAL_MS` pattern.

### A2-1327 — Medium — No paging tier above Discord (G5-90)

Discord is the only alert surface. If Discord is down, ops is down. If the operator isn't looking at Discord, a payout-failed embed at 3am is invisible. Remediation: add a second-tier integration (PagerDuty / OpsGenie / plain SMS via Twilio) for a narrow subset of notifiers (`notifyPayoutFailed`, `notifyOperatorPoolExhausted`, `notifyHealthChange degraded`, `notifyAssetDrift over-minted`), with its own env-var-gated webhook.

---

## 12. Evidence artefacts (re-runnable)

All line citations from `apps/backend/src/**` and `apps/web/app/**` at SHA `450011ded294b638703a9ba59f4274a3ca5b7187`.

- Log-call inventory: `grep -rE 'log\.(info|warn|error|debug|trace|fatal)\(' apps/backend/src --include='*.ts' | wc -l` → 285.
- Child-logger inventory: `grep -rnE 'logger\.child\(' apps/backend/src --include='*.ts' | wc -l` → 117.
- Request-ID forwarding negative: `grep -rn "'X-Request-Id'" apps/backend/src --include='*.ts'` yields only inbound reads and an OpenAPI description, no outbound `fetch(…, { headers: { 'X-Request-Id': … } })`.
- Sentry config matrix: direct reads of `apps/backend/src/app.ts:154–163`, `apps/web/app/root.tsx:37–45`, `apps/web/vite.config.ts` (no `build.sourcemap`), `apps/backend/tsup.config.ts:9` (`sourcemap: true`).
- `@sentry/vite-plugin` absence: `grep -rn "@sentry/vite-plugin\|sentry-cli" apps/web` → 0 hits.
- Web-vitals absence: `grep -rn "web-vitals\|onLCP\|onCLS\|onINP" apps/web` → 0 hits.
- Discord notifier × call-site matrix: `grep -rnE 'notify(OrderCreated|CashbackRecycled|FirstCashbackRecycled|OrderFulfilled|CashbackCredited|HealthChange|PayoutFailed|UsdcBelowFloor|AdminAudit|CashbackConfigChanged|AssetDrift|AssetDriftRecovered|OperatorPoolExhausted|CircuitBreaker|WebhookPing)\(' apps/backend/src --include='*.ts'` → same 15 × {catalog / call-sites} parity confirmed in phase-5d §3.
- Fly log config absence: `apps/backend/fly.toml` and `apps/web/fly.toml` contain no `[log_shipping]` / `[metrics]` / retention block.

No primary source file was modified. No tracker edits. No commits.
