# Vertical Observability — raw findings

Files examined: 49/49 (see Coverage confirmation at bottom)

Scope: `apps/backend/src/discord.ts` + `discord/{admin-audit,monitoring,monitoring-asset-drift,
monitoring-circuit-breaker,monitoring-ctx-schema-drift,monitoring-stuck-sweepers,orders,
notifiers-catalog}.ts` (+ `discord/__tests__/*`), `runtime-health.ts`, `logger.ts`,
`middleware/access-log.ts`, `index.ts` (worker wiring), all 28 `docs/runbooks/*.md`,
`docs/{slo,alerting,oncall,log-policy,error-codes}.md`, plus targeted cross-checks into
call sites (`payments/*`, `orders/*`, `admin/*`, `auth/*`, `ctx/operator-pool.ts`,
`circuit-breaker.ts`, `health.ts`) to verify every `notify*` is wired, catalogued, and
redaction-safe.

Method note: formed independent findings first; the 06-15 raw file was read only after,
per instructions. Several findings below independently reconfirm 06-15 items that are
**still open** (noted explicitly) — this is not double-counting, it's re-verification that
the claimed fixes (CF-33/34, "add missing runbooks", "add check:notifier-coverage gate")
only partially landed.

## Notifier ↔ runbook coverage matrix

29 exported `notify*` functions, all confirmed wired to a real call site (no orphans, no
dead notifiers). All bodies use `escapeMarkdown` + `truncate` + `allowed_mentions:{parse:[]}`
via `sendWebhook` — no raw string interpolation bypassing escaping found anywhere.

| Notifier                          | Call site                                                                                              | Catalog entry? | Runbook?                                                                                                      | Redaction-safe?                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| notifyAdminAudit                  | admin/payout-compensation.ts:235, admin/payouts-retry.ts:208, admin/home-currency-set.ts:178, + others | Yes            | N/A (audit log, not an incident alert)                                                                        | Yes — actor/target last-8                                                |
| notifyAdminBulkRead               | routes/admin.ts:190                                                                                    | Yes            | N/A                                                                                                           | Yes — actor last-8, query w/ truncate                                    |
| notifyCashbackConfigChanged       | admin/upsert-config-handler.ts:213                                                                     | Yes            | N/A                                                                                                           | Yes — actor last-8                                                       |
| notifyCashbackCredited            | orders/procure-one.ts:338                                                                              | Yes            | N/A (success path)                                                                                            | **Partial — userId truncated FIRST-8 (`slice(0,8)`), not last-8** (F-11) |
| notifyCashbackRecycled            | orders/loop-create-response.ts:100                                                                     | Yes            | N/A                                                                                                           | Yes                                                                      |
| notifyFirstCashbackRecycled       | orders/loop-create-response.ts:111                                                                     | Yes            | N/A                                                                                                           | Yes — last-8                                                             |
| notifyOrderCreated                | orders/handler.ts:139                                                                                  | Yes            | N/A                                                                                                           | **Partial — full order id emitted, not last-8** (F-11)                   |
| notifyOrderFulfilled              | orders/get-handler.ts:222                                                                              | Yes            | N/A                                                                                                           | **Partial — full order id emitted** (F-11)                               |
| notifyAssetDrift / Recovered      | payments/asset-drift-watcher.ts:227/236                                                                | Yes            | asset-drift-alert.md                                                                                          | Yes                                                                      |
| notifyCircuitBreaker              | circuit-breaker.ts:113/130/234                                                                         | Yes            | ctx-circuit-open.md (in substance)                                                                            | Yes                                                                      |
| notifyOperatorPoolExhausted       | ctx/operator-pool.ts:463                                                                               | Yes            | operator-pool-exhausted.md                                                                                    | Yes                                                                      |
| notifyOperatorCredentialExpired   | ctx/operator-pool.ts:371                                                                               | Yes            | operator-pool-exhausted.md (§"Single-operator 401")                                                           | Yes                                                                      |
| notifyCtxSchemaDrift              | auth/handler.ts:168/249, merchants/sync.ts:145                                                         | Yes            | ctx-schema-drift.md                                                                                           | Yes                                                                      |
| notifyHealthChange                | health.ts:83                                                                                           | Yes            | health-degraded.md                                                                                            | Yes                                                                      |
| notifyPayoutFailed                | payments/payout-worker-pay-one.ts:309/326                                                              | Yes            | payout-failed-alert.md                                                                                        | Yes                                                                      |
| notifyPayoutAwaitingTrustline     | payments/payout-worker-pay-one.ts:109                                                                  | Yes            | **No dedicated page** — only a mitigation row in stuck-payout.md, not indexed (still open, was 06-15 O-P2-05) | Yes                                                                      |
| notifyPegBreakOnFulfillment       | orders/fulfillment.ts:277                                                                              | Yes            | peg-break-on-fulfillment.md (**new this round — closes 06-15 O-P1-01**)                                       | Yes                                                                      |
| notifyOrderFailedAfterCtxPaid     | orders/procure-one.ts:451                                                                              | Yes            | (covered by stuck-procurement-swept.md family / CF-20 narrative)                                              | Yes                                                                      |
| notifyInterestPoolLow / Recovered | payments/interest-pool-watcher.ts:118/131                                                              | Yes            | interest-pool-low.md (**new this round — closes 06-15 O-P2-04**)                                              | Yes — **but the watcher itself has no liveness instrumentation (F-1)**   |
| notifyRedemptionBackfillExhausted | orders/redemption-backfill.ts:283                                                                      | Yes            | redemption-backfill-exhausted.md                                                                              | Yes                                                                      |
| notifyStuckProcurementSwept       | orders/transitions-sweeps.ts:84                                                                        | Yes            | stuck-procurement-swept.md                                                                                    | Yes                                                                      |
| notifyStuckPayouts                | payments/stuck-payout-watchdog.ts:27                                                                   | Yes            | stuck-payout.md                                                                                               | Yes                                                                      |
| notifyPaymentWatcherStuck         | payments/cursor-watchdog.ts:78                                                                         | Yes            | payment-watcher-stuck.md                                                                                      | Yes                                                                      |
| notifyUsdcBelowFloor              | orders/procure-one.ts:165                                                                              | Yes            | usdc-below-floor.md                                                                                           | Yes                                                                      |
| **notifyDepositSkipRecorded**     | payments/skipped-payments.ts:114                                                                       | **No** (F-3)   | deposit-skip-recorded.md (exists, indexed in README)                                                          | Yes                                                                      |
| **notifyDepositSkipAbandoned**    | payments/skipped-payments.ts:252                                                                       | **No** (F-3)   | deposit-skip-abandoned.md (exists, indexed in README)                                                         | Yes                                                                      |
| notifyWebhookPing                 | admin/discord-test.ts:71                                                                               | Yes            | N/A (manual test ping)                                                                                        | Yes — actor truncated to 8 chars                                         |

**Headline:** 27/29 catalogued, 27/29 runbook-covered (or N/A by design). The 2 gaps
(`notifyDepositSkipRecorded` / `notifyDepositSkipAbandoned` missing from
`DISCORD_NOTIFIERS`) are a **direct, unfixed carry-forward of 06-15 finding O-P2-03** —
see F-3 for why the safety net that should have caught this is itself broken.

## Findings

### F-1 [P1 · GATED (interest accrual is `INTEREST_APY_BASIS_POINTS=0` in Phase 1, goes live with cashback mode)] Interest-pool watcher has zero liveness instrumentation — invisible to `/health`

- File: `apps/backend/src/payments/interest-pool-watcher.ts` (whole file); contrast
  `apps/backend/src/runtime-health.ts:3-10` (`RuntimeWorkerName` union).
- Description: `RuntimeWorkerName` lists exactly 7 workers: `asset_drift_watcher`,
  `auth_row_purge`, `interest_scheduler`, `payment_watcher`, `payout_worker`,
  `procurement_worker`, `redemption_backfill`. Every one of those 7 calls
  `markWorkerStarted` / `markWorkerTickSuccess` / `markWorkerTickFailure` /
  `markWorkerStopped` from its own module. `interest-pool-watcher.ts` — started from
  `index.ts:180-185` alongside `interest_scheduler` whenever interest is live — calls
  **none** of these. Its `tick()` (lines 163-182) only `log.error`s on a thrown exception;
  there is no `markWorkerTickFailure`, so `getRuntimeHealthSnapshot()` never reflects it,
  `/health`'s `workers[]` array never lists it, and the A4-111 staleness fallback
  (`lastSuccessAtMs ?? startedAtMs`) never anchors for this watcher because it's never
  registered in the first place.
- Impact: this is the **only** mechanism that proactively detects the forward-mint pool
  running dry before users are under-allocated (per ADR 009/015 and the new
  `interest-pool-low.md` runbook). If the watcher's `setInterval` callback ever silently
  stops firing (process bug, an awaited call that hangs without throwing inside the
  try/catch, a future refactor that drops the `void tick()` re-arm) there is **no
  independent signal** — `/health` stays green, `notifyHealthChange` never fires, and the
  pool can run to zero with nobody paged until the separate `notifyAssetDrift` watcher
  eventually notices the resulting on-chain/ledger mismatch (a different, later-firing,
  less specific alert). This is exactly the class of bug A4-111 was supposed to close for
  every worker — this one slipped through because it was added as a "sibling to
  asset-drift-watcher.ts" (per its own file header) without copying the runtime-health
  wiring that asset-drift-watcher.ts itself has.
- Evidence: `grep -n "markWorker" apps/backend/src/payments/interest-pool-watcher.ts` →
  no matches. `index.ts:180` starts it unconditionally whenever
  `INTEREST_APY_BASIS_POINTS > 0 && configuredLoopPayableAssets().length > 0`, with no
  corresponding `markWorkerDisabled`/`markWorkerBlocked` call in the `else` branch either
  (contrast `interest_scheduler`, which does get `markWorkerDisabled('interest_scheduler',
'interest APY is zero')` at `index.ts:187`).
- Minimal fix: add `markWorkerStarted('interest_pool_watcher', ...)` /
  `markWorkerTickSuccess` / `markWorkerTickFailure` calls inside
  `startInterestPoolWatcher`'s `tick()`, and a new `'interest_pool_watcher'` member on
  `RuntimeWorkerName`. Wire `markWorkerDisabled` in `index.ts`'s zero-APY / no-issuer
  branches to match the sibling pattern.
- Better fix (if different): same as minimal — this is a small, mechanical fix; no
  architectural alternative needed. Once added, also add `interest_pool_watcher` to the
  `health-degraded.md` triage grep list (see F-7).

### F-2 [P1 · LIVE] `disaster-recovery.md` still references the nonexistent `$LOOP_STELLAR_OPERATOR_ID` — CF-33 only partially fixed

- File: `docs/runbooks/disaster-recovery.md:128` (§"Stellar operator drained").
- Description: CF-33 ("runbook env-var bugs fixed: $LOOP_STELLAR_OPERATOR_ID, floor var
  name") is **only partially closed**. `usdc-below-floor.md` and `stuck-payout.md` were
  both correctly fixed — they now explicitly say *"There is **no** `LOOP_STELLAR_OPERATOR_ID`
  env var"* and derive the public key from `LOOP_STELLAR_OPERATOR_SECRET` via
  `Keypair.fromSecret(...).publicKey()`. But `disaster-recovery.md`'s "Stellar operator
  drained" section — step 3 — still has the original bug:
  `curl ... https://horizon.stellar.org/accounts/$LOOP_STELLAR_OPERATOR_ID`. This env var
does not exist anywhere in `env.ts`(confirmed via`grep -n "OPERATOR_ID" env.ts`→
no matches); the curl resolves to`.../accounts/` (empty) and 404s or returns the wrong
  resource.
- Impact: this is the **P0 DR runbook**, exercised either during a real "operator account
  drained" incident or the documented 180-day rehearsal. An operator following step 3
  verbatim mid-incident — exactly the highest-stress, least-forgiving moment for a wrong
  command — gets a dead curl instead of the balance read they need to confirm the refill
  worked. The fix pattern was already written twice elsewhere in the same PR/commit
  (`e35e58be`, CF-33/34) and simply wasn't swept across the third file that had the same
  bug. This is the same root-cause class the 06-15 audit flagged (x-docs D-01/D-02) — a
  find-and-replace that covered 2 of 3 occurrences.
- Evidence: `grep -rn "LOOP_STELLAR_OPERATOR_ID" docs/ apps/` → only
  `docs/runbooks/disaster-recovery.md:128` remains (plus historical references inside
  `docs/audit-2026-06-15-cold/` which are the prior audit's own findings file, not live
  docs).
- Minimal fix: apply the exact same patch already used in `usdc-below-floor.md`/
  `stuck-payout.md` — replace the bare `$LOOP_STELLAR_OPERATOR_ID` curl with the
  `Keypair.fromSecret(...)` derivation one-liner (or just reference
  `stellar-operator-rotation.md`'s "`/health` also reports the active operator account
  id" pointer, which both fixed runbooks already do).
- Better fix (if different): grep the whole `docs/runbooks/` tree for
  `LOOP_STELLAR_OPERATOR_ID` (and any other env var) as a pre-merge CI check
  (`scripts/lint-docs.sh` already does env-var ↔ `env.ts` parity checking for prose docs
  per AGENTS.md §"Env var parity" — extend that same check to walk `docs/runbooks/*.md`
  too, since runbooks are exactly where a stale/wrong env-var reference is most expensive
  to hit).

### F-3 [P2 · LIVE] `notifyDepositSkipRecorded`/`notifyDepositSkipAbandoned` still absent from `DISCORD_NOTIFIERS` — the "coverage" test can't see them, and `check:notifier-coverage` was never built

- File: `apps/backend/src/discord/notifiers-catalog.ts` (27-entry `DISCORD_NOTIFIERS`
  array — both functions absent); `apps/backend/src/discord.ts:21-45` (the `monitoring.js`
  re-export list also omits both — defined at `discord/monitoring.ts:70` and `:107` but
  never re-exported through the barrel); `apps/backend/src/admin/__tests__/
discord-notifiers.test.ts:64-73` (the existing "coverage" test).
- Description: this is an **unfixed carry-forward of 06-15 finding O-P2-03**, and the
  06-15 remediation plan's "PR L" explicitly promised to "Add `check:notifier-coverage`
  gate (every `notify*` ⇒ catalogued + runbook)" as part of the same CF-33/34 sweep. That
  gate was never built (`grep -rn "notifier-coverage" package.json scripts/` → zero hits;
  no `check:notifier-coverage` npm script exists). What _does_ exist is an older test
  (`discord-notifiers.test.ts`, dated 2026-04-22 — predates even the 06-15 audit) titled
  "covers every notify\* function exported from discord.ts." It works by
  `Object.keys(await import('../../discord.js'))` and asserting every key starting with
  `notify` is in `DISCORD_NOTIFIERS`. This is a **structurally incomplete check**: it only
  sees functions re-exported through the `discord.ts` barrel. `notifyDepositSkipRecorded`/
  `notifyDepositSkipAbandoned` are defined in `discord/monitoring.ts` and consumed
  directly via `import { notifyDepositSkipRecorded, notifyDepositSkipAbandoned } from
'../discord/monitoring.js'` in `payments/skipped-payments.ts` — bypassing the barrel
  entirely. Because they're never re-exported from `discord.ts`, `Object.keys(mod)` never
  sees them, so the "coverage" test trivially passes while the actual catalog is
  incomplete. The admin UI endpoint this catalog backs
  (`GET /api/admin/discord/notifiers`, "what signals can this system send us?") therefore
  silently under-reports — 27 notifiers shown, 29 exist.
- Impact: medium — the underlying alerts fire correctly in production regardless (both
  have real runbooks, confirmed indexed in `runbooks/README.md`), so this is a tooling/
  inventory gap, not a missed page. But it demonstrates the safety net the team believes
  protects against this exact class of drift is itself broken, and `notifyDepositSkipAbandoned`
  — "user paid and got nothing, funds need manual reconciliation" — is precisely the kind
  of alert an operator auditing "what can page us" via the admin surface most needs to see.
- Evidence: see grep results above; `DISCORD_NOTIFIERS` array contents enumerated in full
  in the Coverage matrix section.
- Minimal fix: add both entries to `DISCORD_NOTIFIERS` (channel `monitoring`) — a 6-line
  diff matching the existing entry shape.
- Better fix (if different): (1) also add both to `discord.ts`'s monitoring re-export
  list so the barrel is the true single source every other notifier follows; (2) fix the
  coverage test to walk the actual source files (`discord/*.ts`, excluding `shared.ts`/
  `notifiers-catalog.ts`/`__tests__`) via a glob + `export function notify` regex, or
  better, promote it to the standalone `npm run check:notifier-coverage` script the prior
  audit's remediation plan already committed to, run in `verify.sh` + CI like the sibling
  `check-openapi-parity.mjs` / `check-migration-parity` gates — so this class of drift is
  structurally impossible to reintroduce, not just retroactively caught.

### F-4 [P2 · LIVE] `REDACT_PATHS` missing two currently-deployed secret-bearing env vars: `LOOP_REDEEM_ENCRYPTION_KEY` (CF-25, new this round) and `LOOP_ADMIN_STEP_UP_SIGNING_KEY`/`_PREVIOUS` (ADR-028)

- File: `apps/backend/src/logger.ts:16-132` (`REDACT_PATHS`); contrast `env.ts:264-297`
  (`LOOP_JWT_SIGNING_KEY`/`_PREVIOUS` and `LOOP_ADMIN_STEP_UP_SIGNING_KEY`/`_PREVIOUS` are
  defined back-to-back with near-identical doc comments) and `env.ts:316`
  (`LOOP_REDEEM_ENCRYPTION_KEY`).
- Description: `logger.ts`'s own comment (line 81-86) states the intent precisely: _"env-
  var names for every secret-bearing field loaded into process.env / env.ts. A boot-time
  `log.debug({ env })` would otherwise leak these verbatim."_ It then lists
  `LOOP_JWT_SIGNING_KEY`/`_PREVIOUS`, `GIFT_CARD_API_KEY`/`SECRET`, `RESEND_API_KEY`,
  `DATABASE_URL`, `SENTRY_DSN`, and all three `DISCORD_WEBHOOK_*` vars by literal name.
  Two same-shape, equally-sensitive secrets are missing:
  - `LOOP_REDEEM_ENCRYPTION_KEY` — the AES-256-GCM key that (per CF-25, landed THIS round)
    protects `orders.redeem_code`/`redeem_pin` at rest. A leak of this key fully defeats
    CF-25's encryption-at-rest protection (the ciphertext becomes trivially decryptable),
    yet `index.ts:59-63`'s own boot-warn logic reads `env.LOOP_REDEEM_ENCRYPTION_KEY`
    directly and the variable is otherwise un-redacted if it ever appears in a structured
    log object.
  - `LOOP_ADMIN_STEP_UP_SIGNING_KEY` / `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` — the
    ADR-028 step-up signing key gating credit-adjust/withdrawal/payout-retry. Its sibling
    `LOOP_JWT_SIGNING_KEY` is explicitly redacted two definitions away in `env.ts`, but
    the step-up key was never added to `REDACT_PATHS`.
    Also missing (pre-existing, lower priority, noted for completeness since the audit asks
    for a redaction sweep): `CTX_OPERATOR_POOL` (JSON-encoded per-operator bearer
    credentials, `env.ts:531`), `METRICS_BEARER_TOKEN`, `OPENAPI_BEARER_TOKEN` (probe-gate
    bearer tokens, `env.ts:147-148`) — none matched by the generic `secret`/`apiSecret`
    globs because their field names don't contain those substrings.
- Impact: defense-in-depth gap, not a live exploit — I traced every call site that touches
  `redeemCode`/`redeemPin`/the encryption key (`orders/redemption-backfill.ts`,
  `orders/fulfillment.ts`, `orders/loop-read-handlers.ts`) and none of them currently log
  the raw value (they log `hasCode`/`hasPin` booleans, or `{orderId, field}` on decrypt
  failure — careful code). `index.ts` only logs `{ port: env.PORT }`, not the full `env`
  object, at boot. So today, nothing actually leaks. But `log-policy.md`'s own "PII
  redaction floor" section promises _"Any new field shape that could carry tokens or
  credentials is added to `REDACT_PATHS` in the same PR that introduces it"_ — that rule
  was violated for `LOOP_REDEEM_ENCRYPTION_KEY` in the CF-25 PR itself, and the gap is a
  real footgun for any future debug log, error-context dump, or a careless
  `logger.error({ env, err })` catch-all.
- Evidence: `grep -n "REDEEM_ENCRYPTION\|ADMIN_STEP_UP_SIGNING" apps/backend/src/logger.ts`
  → no matches. `docs/log-policy.md`'s "What gets redacted" list (lines 38-47) also
  doesn't mention either, confirming the doc and code are in lockstep-but-both-wrong
  rather than just a code-only slip.
- Minimal fix: add `LOOP_REDEEM_ENCRYPTION_KEY`, `LOOP_ADMIN_STEP_UP_SIGNING_KEY`,
  `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` (+ `*.` nested variants, matching the existing
  pattern for `LOOP_JWT_SIGNING_KEY`) to `REDACT_PATHS`; update `log-policy.md`'s
  enumerated list in the same PR per its own stated rule.
- Better fix (if different): add a CI-time test that diffs every `z.string()`-typed env
  var in `env.ts` whose name contains `KEY|SECRET|TOKEN` against `REDACT_PATHS` (with a
  small allowlist for genuinely-public ones like `CTX_CLIENT_ID_*`), so a future secret
  addition can't ship without its redaction path — mirroring the existing
  `logger.test.ts` pattern but driven from `env.ts`'s schema instead of a hand-maintained
  fixture list. This closes the whole class (including the pre-existing
  `CTX_OPERATOR_POOL`/`METRICS_BEARER_TOKEN`/`OPENAPI_BEARER_TOKEN` gaps) rather than
  patching three more names by hand.

### F-5 [P2 · LIVE] `docs/slo.md`'s third-party cost/quota table omits Resend and MaxMind

- File: `docs/slo.md:205-226` (§"Third-party quota + cost alerts — A2-1916").
- Description: the table is genuinely good — it covers Anthropic (LLM PR review),
  Sentry, Discord, Fly.io, Stellar/Horizon, Frankfurter (FX feed), Google/Apple OAuth, and
  CTX upstream, each with a quota/ceiling, cost surface, and detection mechanism. Per
  Part 6 §40's explicit ask ("CTX API, Sentry, Resend, MaxMind, LLM-provider usage — any
  quota/cost alerting before a runaway loop... produces a surprise bill or service
  suspension"), two vendors with real per-usage cost/quota exposure are missing:
  - **Resend** (transactional email, `RESEND_API_KEY`) — every OTP send and DSR-export
    notification goes through it. A bug that loops `request-otp` sends (or a targeted
    abuse pattern against the 5/min `POST /api/auth/request-otp` rate limit running
    continuously across many IPs) could exhaust Resend's free-tier quota or rack up a
    surprise bill, and — worse mid-incident — a Resend suspension would silently break
    all new sign-ins (`LOOP_AUTH_NATIVE_ENABLED=true` requires it) with no quota-specific
    detection path documented anywhere.
  - **MaxMind** (GeoLite2, account id + license key build secrets per
    `docs/deployment.md:244-258`) — lower risk (it's a build-time download, not a
    per-request billed call), but it has its own account-level rate/quota that isn't
    mentioned in the cost-alert table at all, and `docs/slo.md`'s own "Freshness" section
    (line 79-88) tracks merchant/location staleness but not GeoLite2 mmdb staleness even
    though the file format can silently go stale if a deploy-time download starts
    failing quietly.
- Impact: moderate — this isn't a money-loss vector on Loop's side (Resend overage is a
  bill, not a ledger event), but it's exactly the "service suspension mid-incident" risk
  the checklist calls out: an exhausted Resend quota during a real incident would compound
  an already-bad day with a second, unrelated outage on the auth surface, undetected until
  users start reporting "I never got my code."
- Evidence: `grep -rn "Resend\|RESEND" docs/slo.md` → no hits; `grep -rn -i "maxmind"
docs/slo.md` → no hits; both vendors are real, current dependencies per
  `docs/deployment.md:116` and `:244-258`.
- Minimal fix: add two rows to the A2-1916 table mirroring the existing shape — Resend:
  quota = plan-tier monthly email cap, cost surface = per-email + overage, detection =
  Resend dashboard quota alert (provision once, same pattern as the other vendors) +
  `recordOtpSendFailure`/`otpDelivery.degraded` in `runtime-health.ts` already gives a
  send-failure signal that should be cross-referenced here. MaxMind: quota = account
  download rate limit, cost surface = free tier (note explicitly), detection = build-time
  log warn if the `.mmdb` download step fails (verify this is wired in the Dockerfile —
  if not, that's a follow-up, not a doc-only fix).
- Better fix (if different): same content, but also add a GeoLite2 mmdb-staleness line to
  the SLO doc's "Freshness" table (the file is baked at build time per-deploy; a stale
  `.mmdb` degrades `/api/public/geo`'s country-guess accuracy silently with no SLI today).

### F-6 [P3 · LIVE — carries forward 06-15 O-P2-05, still open] `notifyPayoutAwaitingTrustline` has no dedicated runbook entry

- File: `docs/runbooks/README.md` (Payouts (Stellar) section, 3 rows: stuck-payout.md,
  payout-permanent-failure.md, payout-failed-alert.md — no row for this notifier);
  `docs/runbooks/stuck-payout.md:53` (only a one-line mitigation row inside the table).
- Description: unchanged since 06-15. The notifier is genuinely self-healing (row stays
  `pending`, resubmits automatically once the user adds the trustline — confirmed in
  `payments/payout-worker-pay-one.ts:109` and the per-(user,asset) dedup in
  `monitoring.ts:193-227`), so a full runbook page may be overkill, but it's still not
  discoverable from the README index by alert title, and the per-(userId,assetCode)
  dedup set (`awaitingTrustlineFired`) has no reset/expiry — once fired for a user it
  never re-fires for that exact pair even across a recovery+re-break cycle within the same
  process lifetime (worth a one-line caveat wherever this gets documented, since "row
  stays pending, no further alert" is the entire mitigation story an on-call needs to
  trust).
- Impact: minor — substantively covered, but the on-call following just the README index
  (the documented entry point per its own "Indices" table) won't find it.
- Minimal fix: add a row to `runbooks/README.md`'s Payouts section pointing at
  `stuck-payout.md`'s existing mitigation row.
- Better fix (if different): give it its own short page (the pattern other "self-healing,
  but ops should still understand it" notifiers like `notifyOperatorCredentialExpired`
  already get inside `operator-pool-exhausted.md`) and note the per-process (not
  per-incident) dedup caveat above.

### F-7 [P3 · LIVE] `health-degraded.md`'s worker-triage grep is stale vs the 7-member (post-F-1, 8-member) `RuntimeWorkerName` set

- File: `docs/runbooks/health-degraded.md:35` vs `apps/backend/src/runtime-health.ts:3-10`.
- Description: the runbook's step 3 suggests `fly logs ... | grep -E "payment
watcher|procurement worker|payout worker|asset drift|interest accrual"` to triage a
  degraded worker. This misses 2 of the 7 `RuntimeWorkerName` members entirely:
  `redemption_backfill` and `auth_row_purge`. It's also not a literal match for the real
  log lines: `orders/redemption-backfill.ts:312` logs `'Starting redemption-backfill
sweeper'` (not matched by any pattern in the grep), `auth/auth-row-purge.ts:98` logs
  `'Starting auth-row purge sweeper'` (not matched either), and `credits/
interest-scheduler.ts`'s actual log text wasn't verified to contain literally "interest
  accrual" either.
- Impact: low — an on-call following this exact command during a `redemption_backfill` or
  `auth_row_purge` degraded-worker incident gets zero log lines back and may incorrectly
  conclude the worker isn't logging at all, rather than that the grep pattern is wrong.
- Evidence: `grep -n "log.info('Starting" apps/backend/src/{orders/redemption-backfill.ts,
auth/auth-row-purge.ts}` confirms the actual strings.
- Minimal fix: extend the grep alternation to
  `"payment watcher|procurement worker|payout worker|asset drift|interest|redemption-backfill|auth-row purge"`.
- Better fix (if different): replace the free-text grep entirely with `curl -s
https://api.loopfinance.io/health | jq '.workers[] | select(.degraded==true)'` — the
  worker name + `blockedReason`/`lastError` are already structured in the `/health`
  response (confirmed in `runtime-health.ts`'s `RuntimeWorkerSnapshot` shape), which is
  both more precise than a Fly-log grep and immune to log-text drift going forward.

### F-8 [P3 · LIVE — carries forward 06-15 O-P3-06, still open despite this file being in this round's delta] `alerting.md`'s monitoring-channel "what fires there" summary is stale

- File: `docs/alerting.md:22`.
- Description: the row still reads _"Health flips, worker stalls, payout
  failures/backlogs, circuit breakers, asset drift, CTX drift"_ — it does not mention
  peg-break, interest-pool low/recovered, deposit-skip recorded/abandoned,
  payout-awaiting-trustline, USDC-below-floor, operator-pool-exhausted, operator-credential
  -expired, or redemption-backfill-exhausted, all of which post to the same
  `DISCORD_WEBHOOK_MONITORING` channel. The delta-manifest lists `alerting.md` as touched
  in this round (the Phase-2 paging-plan candidate list at line 71-74 was updated to add
  `notifyOperatorCredentialExpired`), so this file was in scope and edited, but the
  channel-summary row at the top wasn't revisited.
- Impact: low — purely a "what should I expect in this channel" orientation doc; the
  `DISCORD_NOTIFIERS` catalog (which the doc itself cites as the live source at lines 25
  and 115) is accurate. But a new on-call reading just this prose table gets an
  incomplete picture of channel volume/content.
- Minimal fix: either enumerate the full current list, or replace the prose with "see
  `DISCORD_NOTIFIERS` in `apps/backend/src/discord.ts` for the authoritative, current
  list" (the doc already half-does this elsewhere — make it the single source instead of
  a stale partial enumeration).
- Better fix (if different): same as minimal — this is a doc-prose fix, no code change
  needed. If F-3's `check:notifier-coverage` gate ships, consider generating this table
  from `DISCORD_NOTIFIERS` at doc-lint time so it can't drift again.

### F-9 [P3 · LIVE — carries forward 06-15 O-P3-07, still open] `runbooks/README.md` footer still points at the superseded tracker

- File: `docs/runbooks/README.md:60-64`.
- Description: _"Future runbooks... reference the gap in `docs/audit-2026-tracker.md` if
  a new alert lacks a corresponding page."_ Per `CLAUDE.md`'s own docs index,
  `docs/audit-2026-tracker.md` carries an explicit "superseded" banner (A4-068) and the
  current active tracker is `docs/audit-2026-06-30-cold/tracker.md` (this round) — two
  generations removed from what the footer still names. README.md was touched in this
  delta (4 new runbook rows added, per delta-manifest), so this was an in-scope file that
  still wasn't fully swept.
- Impact: low — an operator following the documented convention to file a "new alert,
  no runbook yet" gap would file it into a dead document nobody reads.
- Minimal fix: repoint to whichever tracker is active at merge time (currently this
  round's `docs/audit-2026-06-30-cold/tracker.md`), or better:
- Better fix (if different): repoint to a stable, never-renamed location instead of a
  dated per-audit tracker that will be superseded again next round — e.g. "file a GitHub
  issue tagged `runbook-gap`" or a permanent `docs/runbook-gaps.md` — so this footer
  doesn't need a doc-only PR every audit cycle just to stay non-stale.

### F-10 [P3 · LIVE] `log-policy.md` claims access-log lines are tagged `area: 'access'`; the actual tag key is `component`, not `area`

- File: `docs/log-policy.md:12` vs `apps/backend/src/middleware/access-log.ts:43`.
- Description: the doc states _"Per-line tag: `area: 'access'`."_ The actual code is
  `const accessLog = logger.child({ component: 'access' });` — the key is `component`,
  not `area`. Every other tagged logger in the codebase (`grep -rn "logger.child"`)
  consistently uses either `area:` or `handler:` or `module:` or `middleware:` as the key
  depending on the call site, but access-log specifically uses `component:`, and the doc
  describing it got the key wrong.
- Impact: low but concretely actionable — an operator running a Fly-log query filtered on
  `area="access"` (per the doc's explicit instruction) would get zero results; the
  correct filter is `component="access"`.
- Evidence: `grep -n "component: 'access'" apps/backend/src/middleware/access-log.ts` →
  line 43; `grep -n "area: 'access'"` anywhere in `apps/backend/src` → no matches.
- Minimal fix: fix the doc's key name from `area` to `component`.
- Better fix (if different): same as minimal; optionally also standardize all
  `logger.child()` call sites on a single tag key name (`area` is used ~20+ places,
  `component`/`module`/`handler`/`middleware` are each used a handful of times) so the
  doc only needs to state one convention instead of needing per-surface caveats.

### F-11 [P3 · LIVE] `discord/orders.ts` notifiers don't follow the project's own last-8-truncation convention; one inverts it

- File: `apps/backend/src/discord/orders.ts:37-58` (`notifyOrderCreated`, full order id,
  positional args), `:159-184` (`notifyOrderFulfilled`, full order id, positional args),
  `:202-231` (`notifyCashbackCredited`, `userId.slice(0, 8)` — **first** 8 chars).
- Description: the codebase has an explicit, repeatedly-cited convention (A2-1314 /
  A2-1313, "ADR-018 last-8 convention" — quoted verbatim in `monitoring.ts:152-157` and
  pinned by a unit-test assertion in `discord/__tests__/monitoring.test.ts:113` —
  "redacts user/order/payout to last-8 (ADR-018 convention)") that Discord embeds never
  carry a full UUID, only the last 8 characters, so a Discord-only viewer can't
  reconstruct a full id while an admin with DB/admin-shell access still can pivot from the
  tail. `discord/orders.ts` — the oldest of the three notifier modules — doesn't follow
  this:
  - `notifyOrderCreated` / `notifyOrderFulfilled` emit the **entire** order UUID
    unredacted (`{ name: 'Order ID', value: \`${escapeMarkdown(orderId)}\` }`).
  - `notifyCashbackCredited` truncates `userId` to `slice(0, 8)` — the **first** 8 chars,
    not the last 8 like every other notifier (`admin-audit.ts`, `monitoring.ts`,
    `monitoring-stuck-sweepers.ts` all consistently use `.slice(-8)`).
  - `notifyOrderCreated`/`notifyOrderFulfilled` also use positional parameters
    (`(orderId, merchantName, amount, currency, ...)`) while every other notifier in the
    codebase (added after these two, evidently) takes a single typed `args` object —
    a maintainability/consistency nit, not a security one.
- Impact: low in practice — I confirmed order reads are owner-scoped
  (`orders/loop-read-handlers.ts:155`: `where: and(eq(orders.id, id),
eq(orders.userId, auth.userId))`), so a full order id leaking into the `orders` channel
  doesn't enable cross-user IDOR on its own; an attacker would still need to be the
  order's owner (or an admin) to read it via the API. But it's a real inconsistency with
  the project's documented threat model for these embeds (`shared.ts`'s own jsdoc and the
  A2-1313/1314 commit messages describe exactly why full ids were removed from Discord
  embeds elsewhere), and the first-8-vs-last-8 split on `userId` specifically is the kind
  of thing that trips up an operator who's learned "always grep the last 8 chars" as the
  pivot convention.
- Evidence: see file:line citations above; cross-referenced against
  `monitoring.ts:152-157`'s explicit comment and `discord/__tests__/monitoring.test.ts`'s
  pinning test for the convention as it's followed elsewhere.
- Minimal fix: change `notifyCashbackCredited`'s `userId.slice(0, 8)` to `.slice(-8)` for
  consistency (one-line fix, no behavior change in security terms since both are
  effectively-random UUID substrings, but it removes the convention-violation surprise).
- Better fix (if different): also truncate `orderId` to last-8 in `notifyOrderCreated`/
  `notifyOrderFulfilled` and convert both to the `args` object shape used everywhere else,
  in the same pass — purely a consistency/maintainability cleanup, do it once rather than
  leaving the two oldest notifiers as the lone holdouts of an otherwise-universal pattern.

### F-12 [P3 · LIVE — carries forward 06-15 O-P3-08 sub-item, still open, very low priority] `operator-pool-exhausted.md` cites the pre-refactor module path

- File: `docs/runbooks/operator-pool-exhausted.md:12`.
- Description: _"Source: `apps/backend/src/discord.ts::notifyOperatorPoolExhausted`"_ —
  the function actually lives in `discord/monitoring.ts:448` now (re-exported through
  `discord.ts`, so the reference still technically resolves for anyone who follows it, but
  it's not where the code is).
- Impact: negligible — cosmetic, doesn't block triage since the re-export means
  `discord.ts` still exports the symbol.
- Minimal fix: update the path to `apps/backend/src/discord/monitoring.ts::notifyOperatorPoolExhausted`.
- Better fix (if different): n/a.

## Delta re-verification

**CF-33** (runbook env-var bugs: `$LOOP_STELLAR_OPERATOR_ID`, floor-var name) —
**PARTIALLY CLOSED.** `usdc-below-floor.md` and `stuck-payout.md` are both correctly
fixed (verified: both now derive the operator pubkey from
`LOOP_STELLAR_OPERATOR_SECRET` via `Keypair.fromSecret(...)` and explicitly call out
"There is **no** `LOOP_STELLAR_OPERATOR_ID` env var"; the floor var is correctly named
`LOOP_STELLAR_USDC_FLOOR_STROOPS` in both, matching `env.ts:406`). However
`disaster-recovery.md:128` — not in the original CF-33 file list but containing the
identical bug — was missed (see F-2). **Verdict: regression remains in one of three
occurrences; close F-2 to fully close CF-33.**

**CF-34** (`error-codes.md` drift; `WEBHOOK_NOT_CONFIGURED` status code) — **CLOSED.**
Cross-checked every literal `code: 'X'` string emitted by a handler across
`apps/backend/src` (49 distinct candidates after stripping currency-code false positives)
against `docs/error-codes.md`'s table — full parity, no undocumented codes found.
`WEBHOOK_NOT_CONFIGURED` is 409 in the handler (`admin/discord-test.ts:67`), the OpenAPI
registration (`openapi/admin-ops-tail-discord-mgmt.ts:117`), and the doc
(`error-codes.md:70`) — all three agree. The 06-15 audit's specific complaint (12
undocumented codes + wrong 503-vs-409) is fully resolved.

## Coverage confirmation

Read in full:

- `apps/backend/src/discord.ts`
- `apps/backend/src/discord/shared.ts`
- `apps/backend/src/discord/admin-audit.ts`
- `apps/backend/src/discord/monitoring.ts`
- `apps/backend/src/discord/monitoring-asset-drift.ts`
- `apps/backend/src/discord/monitoring-circuit-breaker.ts`
- `apps/backend/src/discord/monitoring-ctx-schema-drift.ts`
- `apps/backend/src/discord/monitoring-stuck-sweepers.ts`
- `apps/backend/src/discord/orders.ts`
- `apps/backend/src/discord/notifiers-catalog.ts`
- `apps/backend/src/discord/__tests__/monitoring.test.ts`
- `apps/backend/src/discord/__tests__/admin-audit.test.ts`
- `apps/backend/src/runtime-health.ts`
- `apps/backend/src/logger.ts`
- `apps/backend/src/middleware/access-log.ts`
- `apps/backend/src/index.ts` (worker-wiring sections, lines 1-230)
- `apps/backend/src/payments/interest-pool-watcher.ts`
- `apps/backend/src/auth/auth-row-purge.ts`
- `apps/backend/src/auth/otps.ts` (purgeExpiredOtps), `apps/backend/src/auth/refresh-tokens.ts` (purgeDeadRefreshTokens)
- `apps/backend/src/admin/discord-test.ts`
- `apps/backend/src/admin/discord-notifiers.ts`
- `apps/backend/src/admin/__tests__/discord-notifiers.test.ts`
- `apps/backend/src/orders/redemption-backfill.ts` (full)
- `apps/backend/src/orders/fulfillment.ts` (peg-break section, lines 180-280)
- `docs/runbooks/README.md`
- `docs/runbooks/asset-drift-alert.md`
- `docs/runbooks/ctx-circuit-open.md`
- `docs/runbooks/ctx-schema-drift.md`
- `docs/runbooks/deployed-state-spotcheck.md`
- `docs/runbooks/deposit-skip-abandoned.md`
- `docs/runbooks/deposit-skip-recorded.md`
- `docs/runbooks/disaster-recovery.md`
- `docs/runbooks/dsr.md`
- `docs/runbooks/health-degraded.md`
- `docs/runbooks/interest-pool-low.md`
- `docs/runbooks/jwt-key-rotation.md`
- `docs/runbooks/kill-switch.md`
- `docs/runbooks/ledger-drift.md`
- `docs/runbooks/migration-rollback.md`
- `docs/runbooks/mobile-cert-renewal.md`
- `docs/runbooks/monthly-reconciliation.md`
- `docs/runbooks/operator-pool-exhausted.md`
- `docs/runbooks/payment-watcher-stuck.md`
- `docs/runbooks/payout-failed-alert.md`
- `docs/runbooks/payout-permanent-failure.md`
- `docs/runbooks/peg-break-on-fulfillment.md`
- `docs/runbooks/redemption-backfill-exhausted.md`
- `docs/runbooks/rollback.md`
- `docs/runbooks/stellar-operator-rotation.md`
- `docs/runbooks/stuck-payout.md`
- `docs/runbooks/stuck-procurement-swept.md`
- `docs/runbooks/usdc-below-floor.md`
- `docs/slo.md`
- `docs/alerting.md`
- `docs/oncall.md`
- `docs/log-policy.md`
- `docs/error-codes.md`
- `docs/audit-2026-06-30-cold/checklist.md`
- `docs/audit-2026-06-30-cold/delta-manifest.md`
- `docs/audit-2026-06-15-cold/checklist.md`
- `docs/audit-2026-06-15-cold/raw/v-observability.md` (read AFTER independent findings formed, per instructions)

Plus targeted greps/reads (not full-file) into: `env.ts` (secret env-var inventory),
`packages/shared/src/api.ts` (`ApiErrorCode` enum parity check),
`apps/backend/src/payments/payout-worker-pay-one.ts`,
`apps/backend/src/orders/{procure-one,transitions-sweeps,loop-create-response,handler,get-handler}.ts`,
`apps/backend/src/payments/{asset-drift-watcher,cursor-watchdog,stuck-payout-watchdog,skipped-payments}.ts`,
`apps/backend/src/ctx/operator-pool.ts`, `apps/backend/src/circuit-breaker.ts`,
`apps/backend/src/health.ts`, `apps/backend/src/auth/handler.ts`,
`apps/backend/src/merchants/sync.ts` (notifier call-site confirmation for the coverage
matrix), `docs/deployment.md` (Resend/MaxMind cross-check), `package.json` (script
inventory), `docs/audit-2026-06-15-cold/findings.md` + `remediation-plan.md` (CF-33/34
scope confirmation, read after independent findings).
