# Cold Audit — Dimension 6: Observability, Logging, Alerting, Health

> Scope: `apps/backend/src/discord/**`, `logger.ts`, `runtime-health.ts`,
> `health.ts`, `observability-handlers.ts`, `middleware/access-log.ts`,
> `middleware/probe-gate.ts`, `instrument.ts`, `sentry-scrubber.ts`,
> web `root.tsx` + web Sentry scrubbers, `docs/slo.md`, `docs/alerting.md`,
> `docs/oncall.md`, `docs/log-policy.md`, `docs/error-codes.md`,
> `docs/runbooks/**` (24 runbooks). Branch `fix/stranded-order-hardening`.
> Adversarial cold audit applying checklist dimension 6 in full.

## Coverage

### Notifiers examined (26 functions, 3 channels)

**orders channel** (`discord/orders.ts`): notifyOrderCreated, notifyCashbackRecycled,
notifyFirstCashbackRecycled, notifyOrderFulfilled, notifyCashbackCredited.

**monitoring channel** (`discord/monitoring*.ts`): notifyHealthChange, notifyDepositSkipRecorded,
notifyDepositSkipAbandoned, notifyPayoutFailed, notifyPayoutAwaitingTrustline, notifyUsdcBelowFloor,
notifyInterestPoolLow, notifyInterestPoolRecovered, notifyPegBreakOnFulfillment, notifyAssetDrift,
notifyAssetDriftRecovered, notifyStuckProcurementSwept, notifyPaymentWatcherStuck, notifyStuckPayouts,
notifyRedemptionBackfillExhausted, notifyCtxSchemaDrift, notifyOperatorPoolExhausted, notifyCircuitBreaker,
notifyWebhookPing.

**admin-audit channel** (`discord/admin-audit.ts`): notifyAdminAudit, notifyAdminBulkRead,
notifyCashbackConfigChanged.

### Runbooks examined (23 + README)

asset-drift-alert, ctx-circuit-open, ctx-schema-drift, deployed-state-spotcheck, deposit-skip-abandoned,
disaster-recovery, health-degraded, jwt-key-rotation, kill-switch, ledger-drift, migration-rollback,
mobile-cert-renewal, monthly-reconciliation, operator-pool-exhausted, payment-watcher-stuck,
payout-failed-alert, payout-permanent-failure, redemption-backfill-exhausted, rollback,
stellar-operator-rotation, stuck-payout, stuck-procurement-swept, usdc-below-floor.

### Verified-healthy areas (no findings)

- **Redaction (log)**: `REDACT_PATHS` in `logger.ts` is comprehensive — auth headers, token fields,
  OTP `code`, API creds, Stellar key material, env-named secrets (signing keys, CTX creds, DATABASE_URL,
  Sentry DSN, Discord webhook URLs), admin idempotency keys, all at multiple nesting depths. Log-call
  sweep over `apps/backend/src` found **no** log line emitting an OTP value, redeem code/PIN, token, or
  Stellar secret. The only identifier logged in auth paths is `email`, which is intentional and documented
  (`logger.ts:10-11`, `log-policy.md:49-55`).
- **Redaction (Sentry)**: both pipes wired. Backend `instrument.ts` → `scrubSentryEvent` (`beforeSend`);
  web `root.tsx` → `scrubSentryEvent` + `scrubErrorForSentry` + `forwardQueryErrorToSentry`. Both scrub
  keyed secrets (`SENSITIVE_KEY_RE`, mirroring `REDACT_PATHS`) AND free-text PII (email, Bearer, Stellar
  secret, long-hex) at `event.message` / `exception.values[].value` / `breadcrumbs[]` (A4-074).
- **Sentry env tagging**: both sides honour `LOOP_ENV` / `VITE_LOOP_ENV` over `NODE_ENV`/`MODE`, and
  `SENTRY_RELEASE` / `VITE_SENTRY_RELEASE` for the deploy pivot. `tracesSampleRate` 0.1 prod / 1.0 dev.
- **Worker liveness**: all 6 `RuntimeWorkerName` members (asset_drift_watcher, interest_scheduler,
  payment_watcher, payout_worker, procurement_worker, redemption_backfill) call `markWorkerStarted` +
  tick success/failure. Staleness anchored on `lastSuccessAtMs ?? startedAtMs` so a hung first-tick
  surfaces (A4-111). Exposed on `/health` and `/metrics`.
- **Health two-tier degradation**: critical (DB / required worker) → 503 (Fly cycles); soft (upstream
  slow / catalog stale) → 200 + `softDegradedReasons`. Rolling-window flap-damping + 30-min notify
  cooldown. DB readiness probe (A4-034), upstream probe coalescing + 10s cache. Sound.
- **Probe gate fail-closed**: `/metrics` + `/openapi.json` 404 in production when the bearer env var is
  unset; constant-time compare with length pre-check (`probe-gate.ts`). Documented in deployment.md /
  development.md / .env.example.
- **Discord send hardening** (`discord/shared.ts`): markdown/bidi/zero-width escape, `allowed_mentions:
{parse:[]}`, 5s timeout, fail-silent, non-2xx body scrubbed before logging, embed truncation.
- **Notifier wiring confirmed**: notifyAssetDrift/Recovered (asset-drift-watcher.ts:227/236),
  notifyStuckPayouts (stuck-payout-watchdog.ts:27), deposit-skip (skipped-payments.ts:114/252) all fire
  from real call sites.
- **SLO instrumentation**: availability (`loop_requests_total{status}`), latency (A4-048
  `loop_request_duration_seconds` histogram with PromQL in slo.md), freshness (`/health` stale flags),
  drift (`notifyAssetDrift`), worker/otp gauges — all present and computable.

---

## Findings

### O-P1-01 — `notifyPegBreakOnFulfillment` is self-described "paging-grade" but has NO runbook

- **Severity**: P1 (missing critical control on a money-correctness alert)
- **File**: `apps/backend/src/discord/monitoring.ts:318-340`; catalog
  `discord/notifiers-catalog.ts:125-128`; absent from `docs/runbooks/` and `runbooks/README.md`.
- **Description**: This notifier fires when an order's pinned `chargeCurrency` diverges from the user's
  `homeCurrency` at fulfillment — the off-chain cashback row writes but the **on-chain LOOP-asset payout
  is SKIPPED**, breaking the 1:1 peg until an operator manually compensates. The catalog entry calls it
  "paging-grade." Yet no runbook tells the on-call how to detect, manually compensate, or restore the peg.
- **Impact**: A paging alert about a ledger/peg-correctness divergence with no documented response path.
  On-call gets a 🚨 embed at 3 am and has to reverse-engineer the remediation. Violates checklist §6
  "every notifier has a runbook" and §30 "every alert has a runbook."
- **Fix**: Add `docs/runbooks/peg-break-on-fulfillment.md` (detect via the embed's order/user/charge-ccy,
  reconcile the off-chain row, issue the manual on-chain payout in the correct currency, decide whether to
  reset the user's home currency). Add the row to `runbooks/README.md` and the monitoring line in
  `alerting.md:22`.
- **Ref**: checklist §6, §30; A4-023.

### O-P1-02 — error-codes.md drift: 12 returned codes undocumented + 1 wrong status

- **Severity**: P1 (API-contract doc drift on the documented error envelope; clients branch on these)
- **File**: `docs/error-codes.md` vs handlers in `apps/backend/src/auth/admin-step-up-middleware.ts`,
  `admin/home-currency-set.ts`, `users/favorites-handler.ts`, `orders/loop-handler.ts`,
  `admin/discord-test.ts`.
- **Description**: error-codes.md claims (line 4-5) it is "kept in sync with `packages/shared/src/api.ts`."
  The `ApiErrorCode` enum IS in sync with handlers, but the **doc table is not in sync with the enum** —
  12 codes are emitted by handlers and present in the enum yet missing from the doc:
  `STEP_UP_REQUIRED` (admin-step-up-middleware.ts:78), `STEP_UP_INVALID` (:94),
  `STEP_UP_SUBJECT_MISMATCH` (:112), `STEP_UP_UNAVAILABLE` (:58), `USER_NOT_FOUND`
  (home-currency-set.ts:130), `HOME_CURRENCY_UNCHANGED` (:135), `HOME_CURRENCY_HAS_LIVE_BALANCE` (:144),
  `HOME_CURRENCY_HAS_IN_FLIGHT_PAYOUTS` (:153), `CONCURRENT_CHANGE` (:162), `MERCHANT_NOT_FOUND`
  (favorites-handler.ts:129), `FAVORITES_LIMIT_EXCEEDED` (:178), `PAYMENT_METHOD_DISABLED`
  (loop-handler.ts:325). Additionally **`WEBHOOK_NOT_CONFIGURED`** is documented as **503** (error-codes.md:79)
  but the handler returns **409** (discord-test.ts:67), and the OpenAPI registration agrees it's 409 —
  the doc is the outlier; its "Where" cell path is also wrong (`/config/*/test` vs actual `/discord/test`).
- **Impact**: A client branching on the documented 503 mishandles `WEBHOOK_NOT_CONFIGURED`. The 12
  undocumented codes give no client guidance. The doc's self-described drift guard (lint-docs §9 /
  check-openapi-parity) checks handler↔OpenAPI parity but does **not** enforce enum↔error-codes.md parity.
- **Fix**: Add the 12 rows; fix `WEBHOOK_NOT_CONFIGURED` to 409 + correct path; extend the parity gate to
  cover `ApiErrorCode` ↔ error-codes.md so this class can't recur.
- **Ref**: checklist §3 (consistent error envelope per error-codes.md), §5 (doc↔code drift).

### O-P2-03 — Two live notifiers absent from `DISCORD_NOTIFIERS` catalog (admin UI silently omits them)

- **Severity**: P2 (catalog-vs-code drift; the catalog is the ADR-018 operational-visibility surface)
- **File**: `notifyDepositSkipRecorded` / `notifyDepositSkipAbandoned` defined `discord/monitoring.ts:70,107`,
  fired `payments/skipped-payments.ts:114,252`; **missing** from `discord/notifiers-catalog.ts`
  `DISCORD_NOTIFIERS`.
- **Description**: `DISCORD_NOTIFIERS` is the frozen, admin-rendered catalog of every notifier the backend
  can emit (ADR 018). Its own header (lines 13-15) asserts "a new notifier landing without updating this
  const would be caught in review." Both deposit-skip notifiers slipped through — the admin UI's notifier
  table and any operator inventory silently omit them.
- **Impact**: Operators reviewing "what can page us" via the admin surface see 24 notifiers, not the 26
  that actually exist. `notifyDepositSkipAbandoned` is a "user paid and got nothing — manual reconciliation"
  alert; its absence from the inventory is the worse half.
- **Fix**: Add both entries to `DISCORD_NOTIFIERS` (channel `monitoring`); consider a unit test asserting
  every exported `notify*` is catalogued.
- **Ref**: checklist §6, §14 (consistent patterns across siblings); ADR 018.

### O-P2-04 — `notifyInterestPoolLow` / `Recovered` have no runbook; operator action is a money-moving mint

- **Severity**: P2 (actionable alert without a procedure)
- **File**: `discord/monitoring.ts:255-305`; catalog lines 131-141; absent from `docs/runbooks/`.
- **Description**: notifyInterestPoolLow fires when a LOOP-asset forward-mint pool has fewer than the
  configured min days of cover; the catalog states the operator action is "mint the next batch into the
  pool account" — an on-chain, money-affecting step. No runbook documents how to compute the batch size,
  which account, or how to verify the mint cleared (paired-recovery notifier exists for the close event).
- **Impact**: On-call has no documented procedure for an on-chain mint under time pressure (users go
  under-allocated when cover runs out).
- **Fix**: Add `docs/runbooks/interest-pool-low.md` covering both open/close; index it.
- **Ref**: checklist §6, §30.

### O-P2-05 — `notifyPayoutAwaitingTrustline` has no dedicated runbook

- **Severity**: P2 (alert mapped only as a one-line mitigation row inside another runbook)
- **File**: `discord/monitoring.ts:197-227`; catalog lines 119-122; only a mitigation row in
  `runbooks/stuck-payout.md`, not named in README index.
- **Description**: The notifier is self-healing (row stays `pending`, submits next tick once the user adds
  the trustline), so a full runbook may be overkill — but it is not mapped in the README index and the
  triage (nudge the user to add the trustline) is not documented as its own entry.
- **Impact**: Minor — covered in substance by stuck-payout.md but not discoverable from the alert name.
- **Fix**: Either add a short runbook or add an index row pointing to the stuck-payout.md trustline section
  and note the self-heal so on-call doesn't manually retry.
- **Ref**: checklist §6.

### O-P3-06 — `alerting.md` "what fires there" is stale vs the live monitoring-channel notifier set

- **Severity**: P3 (docs drift)
- **File**: `docs/alerting.md:22` (monitoring-channel row).
- **Description**: The row lists "Health flips, worker stalls, payout failures/backlogs, circuit breakers,
  asset drift, CTX drift" but the monitoring channel also fires peg-break, interest-pool low/recovered,
  deposit-skip recorded/abandoned, payout-awaiting-trustline, USDC-below-floor, operator-pool-exhausted,
  redemption-backfill-exhausted, stuck-procurement-swept. The catalog (`DISCORD_NOTIFIERS`) is the live
  source; the prose summary lags it.
- **Impact**: An operator reading alerting.md to learn what the monitoring channel covers gets an
  incomplete picture.
- **Fix**: Either enumerate fully or replace with "see `DISCORD_NOTIFIERS`" (the doc already cites it as
  the catalogue at line 25/111).
- **Ref**: checklist §5.

### O-P3-07 — runbooks/README.md footer points at a superseded tracker

- **Severity**: P3 (dead doc pointer)
- **File**: `docs/runbooks/README.md:56-60`.
- **Description**: Footer says "reference the gap in `docs/audit-2026-tracker.md` if a new alert lacks a
  corresponding page" — but per CLAUDE.md / its own A4-068 banner, `docs/audit-2026-tracker.md` is
  **superseded**. The pointer for filing new-runbook gaps is stale.
- **Impact**: Operator following the convention files a gap into a dead tracker.
- **Fix**: Repoint to the active audit tracker (`docs/audit-2026-06-15-cold/` or the comprehensive-audit
  Part IV).
- **Ref**: checklist §5 (no references to deleted/superseded files).

### O-P3-08 — env.ts boot warnings use `console.warn` (bypasses Pino redaction); operator-pool runbook file-path nit

- **Severity**: P3 (nit / defence-in-depth)
- **File**: `apps/backend/src/env.ts:622,657,677`; `docs/runbooks/operator-pool-exhausted.md` (cites
  `discord.ts::notifyOperatorPoolExhausted`, symbol now lives in `discord/monitoring.ts` but re-exported
  so it still resolves).
- **Description**: env.ts emits boot-time validation warnings via raw `console.warn` (it runs before the
  logger is constructed). Inspected — they print only non-secret config (flag names, client IDs, USDC
  issuer address), so no leak today. Flagged because raw console bypasses `REDACT_PATHS`; a future warn
  that interpolated a secret-bearing value would not be caught. The runbook file-path reference is
  cosmetically off (re-export keeps it resolving).
- **Impact**: None today; a latent footgun if env validation later logs a secret value.
- **Fix**: Keep env warnings strictly non-secret (add a code comment), or route them through a minimal
  pre-logger redactor. Update the operator-pool runbook path to `discord/monitoring.ts`.
- **Ref**: checklist §6 (redaction), §5.

---

## Alert ↔ runbook coverage gaps (summary table)

| Notifier (actionable)                 | Runbook                                              | Status                                             |
| ------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| notifyHealthChange                    | health-degraded.md                                   | OK                                                 |
| notifyPayoutFailed                    | payout-failed-alert.md + payout-permanent-failure.md | OK                                                 |
| notifyStuckPayouts                    | stuck-payout.md                                      | OK                                                 |
| notifyAssetDrift / Recovered          | asset-drift-alert.md                                 | OK                                                 |
| notifyUsdcBelowFloor                  | usdc-below-floor.md                                  | OK                                                 |
| notifyOperatorPoolExhausted           | operator-pool-exhausted.md                           | OK (minor file-path nit)                           |
| notifyPaymentWatcherStuck             | payment-watcher-stuck.md                             | OK                                                 |
| notifyStuckProcurementSwept           | stuck-procurement-swept.md                           | OK                                                 |
| notifyRedemptionBackfillExhausted     | redemption-backfill-exhausted.md                     | OK                                                 |
| notifyCtxSchemaDrift                  | ctx-schema-drift.md                                  | OK                                                 |
| notifyCircuitBreaker                  | ctx-circuit-open.md                                  | OK in substance (not named by symbol)              |
| notifyDepositSkipAbandoned            | deposit-skip-abandoned.md                            | OK                                                 |
| **notifyPegBreakOnFulfillment**       | —                                                    | **GAP (O-P1-01)**                                  |
| **notifyInterestPoolLow / Recovered** | —                                                    | **GAP (O-P2-04)**                                  |
| **notifyPayoutAwaitingTrustline**     | (row in stuck-payout.md only)                        | **PARTIAL (O-P2-05)**                              |
| notifyDepositSkipRecorded             | —                                                    | acceptable (transient/informational, not terminal) |
| notifyWebhookPing                     | —                                                    | acceptable (manual admin test ping)                |

**No stale/orphan runbooks**: every runbook maps to a real alert or operator procedure. Spot-checked
ledger-drift / stuck-payout / payment-watcher-stuck / redemption-backfill-exhausted / operator-pool-exhausted
runbooks for dead symbol/file/env-var/endpoint references — all referenced symbols, columns, env vars, and
admin endpoints resolve in the codebase (only the operator-pool file-path nit in O-P3-08).

---

## Summary

Observability is **mature and well-instrumented** — comprehensive log + Sentry redaction (both pipes, keyed

- free-text), full worker-liveness + OTP-delivery health surfaces, two-tier health degradation with sound
  flap-damping, fail-closed probe gates, Prometheus histograms backing every stated SLO, and dedup/cooldown on
  every flap-prone notifier well inside Discord's 30 req/min ceiling. The redaction sweep found **no** sensitive
  value (OTP/token/redeem-code/PIN/secret) reaching any log line.

The gaps are at the **alert↔runbook and doc↔code seams**, not in the runtime instrumentation:

- **P0: 0**
- **P1: 2** — peg-break alert has no runbook (O-P1-01); error-codes.md drift, 12 undocumented codes + 1
  wrong status (O-P1-02).
- **P2: 3** — two live notifiers missing from the catalog/admin surface (O-P2-03); interest-pool-low
  runbook missing (O-P2-04); payout-awaiting-trustline only partially mapped (O-P2-05).
- **P3: 3** — alerting.md monitoring-channel summary stale (O-P3-06); README footer points at superseded
  tracker (O-P3-07); env.ts raw-console boot warnings + runbook path nit (O-P3-08).

Common root cause across O-P1-01/O-P2-03/O-P2-04: **no enforced gate** asserting that every exported
`notify*` is both catalogued in `DISCORD_NOTIFIERS` AND has a runbook (the way openapi-parity enforces
route↔spec). Recommend a `check:notifier-coverage` script mirroring the existing parity gates — it would
mechanically close this entire class.
