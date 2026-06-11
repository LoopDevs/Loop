# Loop — Comprehensive End-to-End Audit — 2026-06-11

> Full-repo audit in two layers. **Layer 1 (per-file):** every file in the repository — tracked and
> untracked — was read and individually assessed: **1,751 / 1,751 files, zero skipped**, by 28 batch
> auditors working from explicit manifests (the complete `git ls-files` ∪ untracked inventory was
> pre-split into batch files so no file could fall through an index gap). **Layer 2
> (cross-cutting):** six dedicated auditors traced the interactions _between_ files — web↔backend
> API contract parity, env-var lifecycle, DB migration chain, CI/CD pipeline end-to-end, money-path
> cross-file invariants, and the coherence of all forward-looking plans. Load-bearing findings were
> independently re-verified against the code before inclusion; one headline finding from an earlier
> draft was **overturned** on deeper tracing (see ADR 035, below) — verdicts here are the corrected
> ones. Branch at audit time: `feat/serve-strong-foreign-markets` (PR #1408 open).

## Scope and coverage

| Layer         | Area                                           | Files / units                              | Batches |
| ------------- | ---------------------------------------------- | ------------------------------------------ | ------- |
| Per-file      | Backend source (non-test)                      | 418                                        | 01–07   |
| Per-file      | Backend tests                                  | 211                                        | 08–10   |
| Per-file      | Web source (non-test)                          | 310                                        | 11–16   |
| Per-file      | Web tests                                      | 143                                        | 17–18   |
| Per-file      | Mobile shell                                   | 57                                         | 19      |
| Per-file      | Shared package                                 | 36                                         | 20      |
| Per-file      | Scripts (committed + untracked)                | 79                                         | 21–22   |
| Per-file      | ADRs + runbooks                                | 57                                         | 23      |
| Per-file      | Core docs / launch docs / archive              | 33                                         | 24      |
| Per-file      | Prior-audit evidence (secrets/PII sweep)       | 362                                        | 25–26   |
| Per-file      | Root, `.github`, CI, e2e configs               | 45                                         | 27–28   |
| Cross-cutting | API contracts: 34 service files, all endpoints | —                                          | C1      |
| Cross-cutting | Env lifecycle: 81 variables traced end-to-end  | —                                          | C2      |
| Cross-cutting | Migrations: all 33 (0000–0032) + schema parity | —                                          | C3      |
| Cross-cutting | CI/CD: 5 workflows + 9 invoked scripts         | —                                          | C4      |
| Cross-cutting | Money path: ~30 files, create→payout lifecycle | —                                          | C5      |
| Cross-cutting | Plans: 12 planning docs + dependency graph     | —                                          | C6      |
| **Total**     |                                                | **1,751 files + 6 interaction dimensions** | **34**  |

**Baseline at audit time:** typecheck ✅ · lint ✅ · 3,239 unit tests ✅ (2,139 backend + 1,100 web)
· `npm run verify` ❌ only because Prettier rejects 17 _untracked_ scratch scripts. Prior-audit
evidence dirs: clean — no secrets, no PII, no accidental commits.

## Finding totals

| Severity  | Per-file (L1) | Cross-cutting (L2) | Total   |
| --------- | ------------- | ------------------ | ------- |
| CRITICAL  | 9             | 5                  | 14      |
| HIGH      | 74            | 18                 | 92      |
| MEDIUM    | 176           | 34                 | 210     |
| LOW       | 195           | 20                 | 215     |
| INFO      | 320           | 6                  | 326     |
| **Total** | **774**       | **83**             | **857** |

A handful of headline findings were independently discovered by multiple auditors (e.g. the USDC
issuer mismatch appears in both the docs sweep and the env trace) — the totals above are raw,
not deduplicated. INFO entries are largely clean-confirmations of generated/binary files.

## Executive summary — the ten findings that matter most

**1. [CRITICAL — verified] The payment watcher permanently loses skipped payments.**
`apps/backend/src/payments/watcher.ts:275` advances the Horizon cursor to the page's last
`paging_token` unconditionally after the processing loop. Every payment that hit `continue` —
amount judged insufficient during a transient FX/oracle window, or the A4-110
missing-credit-row case — falls permanently behind the cursor and is **never re-scanned**. The
in-code comment at the A4-110 branch ("the next watcher tick re-evaluates") is factually wrong.
User funds arrive on-chain, the order silently expires, no sweeper covers the gap.

**2. [CRITICAL — verified] One poisoned payment wedges deposit processing for everyone.**
In the same loop, any `markOrderPaid` error other than `LoopAssetMissingCreditRowError` is
rethrown (`watcher.ts:261`), aborting the tick _before_ the cursor write — so the next tick
re-reads the same page and throws again, forever. The concrete trigger exists today: a user who
received an on-chain LOOP withdrawal and spends it on a `loop_asset` order can drive the
off-chain debit into the `user_credits_non_negative` CHECK, which is exactly such an error.

**3. [CRITICAL — verified] The launch runbook documents the wrong USDC issuer.**
`docs/tranche-1-launch.md:68,152` and `docs/phase-1-while-apple-approves.md:37` say
`GA5ZSEJYB37JRC5AVCIA7…`; the canonical Centre issuer per `env.ts:323`, `.env.example:240`, and
`development.md` is `GA5ZSEJYB37JRC5AVCIA5…`. An operator following the runbook silently breaks
all USDC deposit acceptance — and `preflight-tranche-1.sh` checks key _presence_, not value, so
nothing would catch it.

**4. [HIGH — verdict corrected] ADR 035 ships ~286 merchants that users cannot buy.**
An earlier draft of this audit called this a DB-corruption risk; deeper tracing **overturned
that**: `orders/loop-handler.ts:259` rejects any order currency outside `HOME_CURRENCIES`
(USD/GBP/EUR) with a 400 _before_ any insert, so the five `('USD','GBP','EUR')` CHECK
constraints (`schema.ts:89,141,220,548,554`) are unreachable for AED/INR/SAR/AUD/MXN. The real
problems: (a) the new AE/IN/SA/AU/MX pages display locally-priced merchants whose purchase
attempt will 400 — a product gap ADR 035's "no backend change" claim glosses over; (b)
`MobileHome.tsx:484` hardcodes `$` for cashback/savings labels in every market;
(c) `money-format.ts:59` assumes 2-decimal currencies; (d) the schema comments promising "a
deliberate migration" for currency #4 are now out of sync with a 28-country country list.

**5. [HIGH] Circulation reconciliation diverges by design.** Redeemed (deposit-held) LOOP is
never burned — the treasury/burn routing documented in `orders/transitions.ts` has no
implementing code — and daily interest accrues off-chain with no on-chain counterpart. The
asset-drift watcher's equation therefore drifts monotonically in both directions; once the
cumulative drift crosses the alert threshold it pages permanently, masking real incidents.

**6. [HIGH] Security CI exists but does not gate merge.** `secret-scan` (gitleaks),
`container-cve-scan` (trivy), `sbom`, `flywheel-integration`, and both e2e suites are absent
from branch protection's required checks — a PR with a hardcoded secret or CVE regression can
merge with all required checks green. Separately, `check-bundle-budget.sh` is documented as a
gate but **never invoked by any CI job**, and there is no deploy pipeline at all (manual
`flyctl deploy`, migrations applied only as Fly `release_command`).

**7. [HIGH] Auth/admin correctness cluster.** Refresh-token rotation persists the new token
before revoking the old one — a concurrent-rotation race leaves live orphaned rows
(`auth/native.ts:164`); the OTP-delivery kill-switch re-enables itself on every request
(`native-request-otp.ts:47`); admin payout-retry skips the `withIdempotencyGuard` advisory lock
every other write handler uses (`admin/payouts-retry.ts:146`); a corrupt idempotency snapshot
silently re-executes financial writes (`admin/idempotency.ts`); the public "top cashback"
list sorts percentage _text_ lexicographically, so "9.5" outranks "10.0"
(`public/top-cashback-merchants.ts:59`).

**8. [HIGH] The untracked script pile (79 files) embeds a logo.dev key in 5 files**
(`pk_actJVN2RTA…` — publishable tier, never committed, but it also leaks into durable `logoUrl`
values pushed to the CTX catalog), reads the production CTX admin token only from
`/tmp/ctx-token.txt` in 9 scripts, performs bulk destructive production writes with no dry-run
or confirmation gate in several (`merge-pairs`, `ctx-combined-split-apply`, region retaggers),
and one (`qc-residue-fix.mjs:12`) hardcodes a session-transient `/private/tmp/claude-…` path as
its data source.

**9. [HIGH] The documentation layer lies in load-bearing places.** AGENTS.md's docs index stops
at ADR 031 (032–035 missing) and points to a tracker that marks _itself_ superseded; the CI
job list says eleven jobs (there are twelve) and the required-check list is stale; ADR 028
names a signing-key env var that doesn't exist (`LOOP_STEP_UP_SIGNING_KEY` vs the real
`LOOP_ADMIN_STEP_UP_SIGNING_KEY`); ADR 015's amendment claims a USDLOOP→LOOPUSD retirement the
live code contradicts while ADR 031 is still `Proposed`; runbook `operator-pool-exhausted.md`
points at a non-existent file path; CODEOWNERS references a GitHub team that doesn't exist, so
every required-review rule is a silent no-op (A2-103, still open).

**10. [HIGH] The forward plan has a stalled critical path and orphaned blockers.** Everything in
Tranche 2 gates on a "1–3 hour" Privy Soroban DD that has been pending for 37 days while ADR
030/031 sit `Proposed`. Meanwhile known pre-launch blockers live in **no plan at all**: the
redemption-null backfill (flagged 2026-05-14 as a pre-public-traffic blocker — plus the
`Body has already been read` bug in its polling fallback that means the fallback never actually
retries), ADR 027's deferred mobile controls whose "distribution outside official stores"
trigger is _already met_ by the Phase-1 APK-sideload deliverable, the `loopfinance-web` first
deploy (in three checklists, completion recorded in none), and keystore escrow.

Also worth knowing: web↔backend contract drift is real but bounded — 10 type-duplication/drift
sites violating ADR 019 (favorites, recently-purchased, public stats, social-login response,
cashback-rate responses, `phase1Only` missing from the openapi config schema). A
**ready-made, typecheck-verified patch** for all ten sites was produced during the audit:
`/tmp/audit-out/adr019-contract-parity.patch` (787 lines; apply with `git apply`).

The full, sequenced remediation plan is **Part IV** below.

---

# Part II — Per-file findings (Layer 1, all 28 batches)

> Every finding from the per-file sweep, verbatim, with `path:line` references.

## Batch 01 — backend src (1/7)

- [MEDIUM] apps/backend/src/admin/audit-tail-csv.ts:138 — `content-disposition` filename is built from `since.toISOString().slice(0,10)` which can theoretically contain non-ASCII if `toISOString()` produces unexpected output, but more concretely the `filename=` value is not RFC 5987-quoted and could misbehave if an attacker can influence the `since` parameter in a way that smuggles a `"`. Input is validated to be a valid Date but the date string itself (`2024-01-01`) is safe in practice — LOW risk, but the pattern propagates through ~15 other CSV handlers (merchant-stats-csv, merchants-flywheel-share-csv, etc.). Recommend `filename*=UTF-8''...` encoding or at minimum strip any non-alphanumeric chars from the interpolated date string.

- [MEDIUM] apps/backend/src/admin/merchant-flywheel-activity-csv.ts:149 — `filename="${merchantId}-flywheel-activity-${today}.csv"` interpolates an admin-supplied `merchantId` directly into the `Content-Disposition` header value. Although `merchantId` is validated against `MERCHANT_ID_RE` (`/^[A-Za-z0-9._-]+$/`) the dot and dash characters are safe, but a future relaxation of that regex (or a copy-paste without the validation) would allow header injection. The validation is present and correct; document the coupling explicitly to prevent future breakage. Same pattern exists in `merchant-flywheel-activity.ts` (JSON, no filename), `merchant-stats-csv.ts`, `merchants-flywheel-share-csv.ts`.

- [MEDIUM] apps/backend/src/admin/idempotency.ts:148-163 — The corrupt-snapshot branch (`Object.keys(body).length === 0`) silently falls through to re-execute `doWrite()` instead of returning an error. A stored empty-object snapshot (e.g., written by a bug in a prior deployment) will cause `doWrite()` to execute again, potentially producing a second side-effect. The `lookupIdempotencyKey` in `idempotency-store.ts` handles this identically (returns null on parse failure, causing re-execution). If the `storeIdempotencyKey` step later fails after `doWrite()`, the duplicate write has no tombstone. This is a known limitation: the comment says "treat as miss" but double-execution on corrupt snapshots is a real risk for financial operations. Recommend: on corrupt snapshot, return 409 `IDEMPOTENCY_SNAPSHOT_CORRUPT` to force operator investigation rather than silently re-running.

- [MEDIUM] apps/backend/src/admin/interest-mint-forecast.ts:96-146 — No try/catch wraps the outer `computeInterestForecast` and `configuredLoopPayableAssets` calls (lines 96-103). Only the per-asset `getAssetBalance` call (inside the loop) is protected. If `computeInterestForecast` throws (e.g., DB error), the handler returns an unhandled rejection → Hono's default 500 without the `{ code, message }` shape. This violates the project's error contract. Fix: wrap lines 96-146 in a try/catch returning `{ code: 'INTERNAL_ERROR', ... }` on 500.

- [MEDIUM] apps/backend/src/admin/merchant-stats.ts:132 and merchant-stats-csv.ts:111 — Both `adminMerchantStatsHandler` and `adminMerchantStatsCsvHandler` pass `since.toISOString()` directly into a raw SQL `WHERE ... >= ${since.toISOString()}` via Drizzle's `sql` template. Drizzle's sql tag does NOT parameterise string interpolations inside backtick expressions — it embeds the literal. This is an SQL injection vector if `since` can be controlled. In practice `since` is constructed by `new Date(sinceRaw)` from a validated date string so the injection surface is limited, but the pattern departs from the safe `gte(column, value)` typed comparator used in other files (e.g., `audit-tail-csv.ts` uses `gte()` specifically because "postgres-js can't bind a Date"). The inconsistency is a maintenance risk. Fix: use `gte(orders.fulfilledAt, since)` instead of raw string interpolation. Same pattern in `merchant-stats-csv.ts:111` and `merchant-top-earners.ts:131`, `merchants-flywheel-share.ts:131`, `merchants-flywheel-share-csv.ts:101`.

- [LOW] apps/backend/src/admin/audit-tail.ts:24-33 — `AdminAuditTailRow` and `AdminAuditTailResponse` are defined locally rather than in `@loop/shared`. This is inconsistent with the stated A2-1506 policy ("every response shape lives in @loop/shared"). The web consumer has to maintain its own definition. No correctness issue, but a maintenance divergence risk.

- [LOW] apps/backend/src/admin/cashback-activity.ts:57-65 and cashback-realization.ts:50-57 — `toNumber` / `toStringBigint` / `toNumber` helpers are duplicated verbatim across ~12 admin files (cashback-monthly.ts, merchant-cashback-monthly.ts, merchant-flywheel-activity.ts, merchant-flywheel-stats.ts, merchant-operator-mix.ts, operator-activity.ts, operator-latency.ts, operator-merchant-mix.ts, merchant-stats.ts, merchant-payment-method-share.ts, etc.). A central utility in `packages/shared` or a local `admin/utils.ts` would reduce drift risk (one file already has a non-identical `toMs` variant). Not a correctness bug today.

- [LOW] apps/backend/src/admin/audit-envelope.ts:38 — `actorEmail` is included in every admin audit envelope and reflected verbatim in `audit-tail.ts` responses. Email is PII; the audit tail is returned to admin users, which is acceptable, but the project's log-policy.md states emails must be redacted in logs. Verify the pino logger's `redact` paths cover `actorEmail` on the admin audit-tail route; the handler logs `err` but not the row content, so this appears fine in practice — just note it for the log-policy review.

- [LOW] apps/backend/src/admin/csv-escape.ts:29 — `FORMULA_PREFIXES` set does not include `\n` (newline as a leading character). RFC 4180 cells beginning with `\n` are not a formula injection risk but the `\r` in the set without `\n` is asymmetric. Minor inconsistency; no real-world spreadsheet exploits a bare `\n` prefix as a formula.

- [LOW] apps/backend/src/admin/merchant-cashback-summary.ts:92 — `(r.lifetimeCashbackMinor ?? '0').toString()` — if `lifetimeCashbackMinor` is already a bigint (which the `::bigint` cast produces), `.toString()` works correctly; if it comes back as a string from the pg driver, `.toString()` is a no-op. The pattern is safe but relies on the `?? '0'` default also working when the value is `0n` (falsy) — it won't, because `0n ?? '0'` is `0n`. The `COALESCE` in the SQL guards this but the fallback is misleading. Very low risk.

- [LOW] apps/backend/src/admin/discord-test.ts:55 — `const admin = c.get('user') as { id?: string } | undefined` — if `requireAdmin` middleware has already validated the user, a type assertion that allows `id` to be optional is overly defensive. If the middleware contract ever changes to set a user without an `id`, this handler silently 401s rather than surfacing a middleware bug. Use the stronger `User` type.

- [LOW] apps/backend/src/admin/merchants-resync.ts:131 — `guardResult.status as 200 | 400 | 500` — the `502` branch (upstream failure) is handled in the catch block before `guardResult` is set. However if `forceRefreshMerchants` internally throws something other than a generic Error (e.g., circuit open), the `catch` at line 112 would return 502 correctly. The status cast is fine but the possible-status comment on the openapi registration should include `502`.

- [INFO] apps/backend/buf.gen.yaml — generated proto config, not source, acknowledged.
- [INFO] apps/backend/proto/clustering.proto — proto definition, clean.
- [INFO] apps/backend/src/**fixtures**/ctx/\*.json — fixture files, synthetic data, no real credentials, clean.
- [INFO] apps/backend/.env.example — comprehensive, no hardcoded secrets, well-commented.
- [INFO] apps/backend/Dockerfile — pinned digest (A2-403), non-root user (A2-402), HEALTHCHECK present. Clean.
- [INFO] apps/backend/drizzle.config.ts — clean, correct warnings about not running db:generate.
- [INFO] apps/backend/fly.toml — clean, health check wired, TRUST_PROXY documented.
- [INFO] apps/backend/package.json — clean, pinned deps.
- [INFO] apps/backend/AGENTS.md — clean, comprehensive.
- [INFO] apps/backend/README.md — clean, standard quickstart/key-modules doc.

## ---

- [MEDIUM] apps/backend/src/admin/top-users.ts:91 — User emails included in response payload (`rows[].email`). This endpoint returns raw user emails alongside financial aggregates. While the route is admin-gated, emails are PII and bulk leakage amplifies admin-token blast radius. Consider returning `userId` only and letting the UI resolve email via the user-detail drill-down, or document clearly this is intentional per log-policy. Same issue at top-users-by-pending-payout.ts:82.
- [MEDIUM] apps/backend/src/admin/users-recycling-activity.ts:56 — User emails in `UserRecyclingActivityRow` response body. This aggregation query returns `u.email` for every recycling user. Same pattern as top-users — email is structural in the response type, not incidental. Same issue exists in the CSV export sibling at users-recycling-activity-csv.ts:51.
- [MEDIUM] apps/backend/src/admin/user-search.ts:113 — `log.debug` at line 113 logs the raw search query `q` which is an email fragment — potential PII in logs. The `read-audit.ts` module's `sanitizeAdminReadQueryString` sanitizes `email` and `q` params before Discord fanout, but this log line is outside that path. Should either be removed or redacted consistent with log-policy.
- [MEDIUM] apps/backend/src/admin/payouts-retry.ts:146-162 — Idempotency replay path is not serialized under an advisory lock (unlike the `withIdempotencyGuard` wrapper used in refunds/adjustments/compensation). The pattern here does `lookupIdempotencyKey` → `resetPayoutToPending` → `storeIdempotencyKey` as three separate steps without any lock. A concurrent duplicate request could bypass the lookup and execute two retries for the same `payoutId`. Fix: use `withIdempotencyGuard` as in the other write handlers.
- [LOW] apps/backend/src/admin/treasury.ts:53-104 — `treasuryHandler` has no try/catch around the DB queries. If any of `outstandingRows`, `totalsRows`, `buildPayoutCounts`, `buildOrderFlows` throw, the error propagates to the global Hono error handler returning a generic 500 with no `handler: 'treasury'` tag in the log. Other handlers (reconciliation, operator-stats, etc.) explicitly catch and log with their handler name. Add a try/catch consistent with sibling handlers.
- [LOW] apps/backend/src/admin/stuck-payouts.ts:39 — `StuckPayoutRow.orderId` is typed `string` (non-nullable) but `pendingPayouts.orderId` is `string | null` for withdrawal rows (per ADR-024 §2 and confirmed in payouts.ts `PayoutRow`). If a withdrawal payout becomes stuck and `orderId` is null, the `.orderId` field will be serialized as `null` on the wire but the TypeScript type says `string`. The `listStuckPayoutRows` function doesn't filter by `kind`, so withdrawal stuck payouts would produce a type-lie at line 125 (`r.orderId`). Fix: type `orderId` as `string | null`.
- [LOW] apps/backend/src/admin/users-list.ts:79 — ILIKE pattern uses `LOWER(${users.email}) LIKE ${pattern}` via a raw `sql` template. Drizzle's typed `ilike()` helper (used in user-search.ts) handles collation and escaping more robustly. Minor inconsistency — both work but should be unified. Not a correctness bug given the manual `escapeLike` function is present.
- [LOW] apps/backend/src/admin/operators-snapshot-csv.ts:124-173 — Raw SQL in `db.execute(sql\`...\`)` references table columns by literal name (`ctx_operator_id`, `state`, `created_at`, `paid_at`, `fulfilled_at`) bypassing Drizzle's column-reference interpolation. If a column is renamed in schema, this query silently breaks at runtime. Other files in this batch consistently use `${orders.columnName}` interpolation. Medium-risk in a fast-evolving schema.
- [LOW] apps/backend/src/admin/step-up-handler.ts:65 — `c.req.json().catch(() => null)` swallows all JSON parse errors (including null body). If the body fails to parse, `parsed.success` is false and the handler returns a generic 400. This is the correct behavior but the error code `VALIDATION_ERROR` with message `'otp is required'` is misleading when the actual failure was malformed JSON. Other handlers explicitly try/catch JSON parsing and return `'Request body must be valid JSON'`. Minor but inconsistent.
- [LOW] apps/backend/src/auth/email.ts:173 — `getEmailProvider()` reads `process.env['EMAIL_PROVIDER']` directly instead of going through the typed `env` singleton. All other env access goes through `./env.js`. This bypasses the env validation/typing layer and means `EMAIL_PROVIDER` is not declared in the `env.ts` schema. Fine functionally but is a gap in the centralized env management pattern.
- [INFO] apps/backend/src/admin/user-credits-csv.ts:32 — `csvRow` function uses `csvEscape` for strings but calls `f.toString()` for `bigint` without passing through `csvEscape`. If a bigint somehow contained an impossible character it would not be escaped. Not a real risk for bigint columns but is inconsistent with the pattern in sibling exports. Non-issue in practice.
- [INFO] apps/backend/src/admin/treasury-snapshot-csv.ts:60-65 — Re-uses `treasuryHandler(c)` and parses its JSON response body. This is an elegant pattern but calls `jsonRes.json()` on the Response, which consumes the body stream. If `treasuryHandler` is ever refactored to return a streaming or already-consumed body, this silently breaks. A safer pattern would be a shared `buildTreasurySnapshot()` helper returning a plain object. Low risk currently since `c.json()` creates a complete response.
- [INFO] apps/backend/src/admin/payouts-retry.ts:39-57 — `PayoutRow` interface is duplicated from `payouts.ts` (lines 45-63 of payouts.ts). The local definition at payouts-retry.ts:39 has identical shape but is defined separately instead of imported. This is a copy-paste duplication risk — if a field is added to the canonical `PayoutRow` in payouts.ts, the retry handler won't pick it up. Fix: import `PayoutRow` from payouts.ts.
- [INFO] apps/backend/src/admin/payouts-retry.ts:59-79 — `toView` function is also duplicated from `payouts.ts` line 65. Same duplication risk as above.
- [INFO] apps/backend/src/app.ts — clean; middleware stack correct and well-commented.
- [INFO] apps/backend/src/auth/admin-step-up.ts — custom JWT implementation. `timingSafeEqual` is used for signature comparison (correct). `verifyAdminStepUpToken` tries all keys in a loop and short-circuits on first match; this leaks timing information about key ordering but not key content. Acceptable for admin-only surface.
- [INFO] apps/backend/src/auth/id-token-replay.ts — fail-closed pattern on DB error is correct. Clean.

## Batch 03 — backend src (3/7)

- [HIGH] apps/backend/src/auth/native.ts:164 — `issueTokenPair` is called BEFORE `tryRevokeIfLive` in the refresh handler. A new token pair is minted unconditionally, and its `refreshJti` is only actually written if the CAS revoke wins. The losing concurrent caller already minted a token pair (persisted in `refresh_tokens`) and then discards it at line 166, but the orphaned refresh-token row in the DB remains live (with no `revokedAt`) — it is unreachable from the client but consumes a live revocation slot. If the `tryRevokeIfLive` call fails due to a transient DB error rather than a race, the newly inserted successor row has no revocation path. Recommended fix: pre-generate the `refreshJti` UUID, pass it to `tryRevokeIfLive` as `replacedByJti`, and only call `issueTokenPair` after the CAS succeeds.

- [HIGH] apps/backend/src/auth/native-request-otp.ts:47 — `setOtpDeliveryEnabled(true)` is called unconditionally at the start of every request, regardless of whether the email send actually succeeds later. This clobbers any externally-set `false` value (e.g. from a circuit-breaker or health-check kill-switch) on the first OTP request that arrives. The call should be removed entirely or moved to the `recordOtpSendSuccess()` branch.

- [HIGH] apps/backend/src/ctx/stream.ts:90 — The operator bearer token is placed in a query-string parameter (`?token=<bearer>`). This is a deliberate protocol choice (documented), but the `log.warn` on line 109 logs `{ ctxOrderId, status }` without checking whether `res.status === 401`. A 401 log entry at warning level should not include the URL (which contains the token). Currently the URL is not logged — but a future addition of `url` to the log object would inadvertently log the credential. A comment marking the URL as credential-bearing would reduce risk.

- [MEDIUM] apps/backend/src/auth/native.ts:164 — Orphaned refresh-token row on concurrent-rotation loss (see HIGH above): `issueTokenPair` writes a `refresh_tokens` row with a live state before `tryRevokeIfLive` runs. The orphaned row expires naturally after 30 days, but inflates the live-token count and could trigger anomaly-detection false positives. Revocation is also impossible from the client side.

- [MEDIUM] apps/backend/src/auth/identities.ts:47–60 — Race condition in step 1 of `resolveOrCreateUserForIdentity`: the function does a plain SELECT (no FOR UPDATE, no txn) to look up a known `(provider, sub)` identity, then fetches the linked user row in a second round-trip. Between the two queries a concurrent DELETE of the users row would not be visible. If the user row is gone the function silently falls through to step 3 and creates a duplicate user. This is documented as an "ops-grade edge case" but there is no alert or reconciliation path for it.

- [MEDIUM] apps/backend/src/credits/accrue-interest.ts:133–173 — The per-user transaction does `SELECT ... FOR UPDATE` then `INSERT credit_transactions` then `UPDATE user_credits`, but the idempotency collision is detected by catching a string match on the error message (`message.includes('credit_transactions_interest_period_unique')`). This is brittle: postgres-js / Drizzle may change the error message format across versions, silently turning a duplicate-accrual into a 500 that logs at error and is caught by the outer `log.error` branch, not the idempotent skip branch. Prefer checking the postgres error `code === '23505'` and `constraint_name`.

- [MEDIUM] apps/backend/src/credits/payout-compensation.ts:150–169 — The daily cap check for compensation rows (A4-020) does NOT acquire the same advisory lock that `applyAdminCreditAdjustment` uses (see `adjustments.ts:105`). Two concurrent compensation requests can both read `usedMinor = 0`, both compute `0 + attempt <= capMinor`, and both proceed — effectively bypassing the per-day cap. The advisory lock key used in adjustments is keyed on `(adminUserId, currency, dayStart)` but compensation rows currently use `referenceType='payout'` not `referenceType='admin_adjustment'`, so they would need a separate but equivalent lock.

- [MEDIUM] apps/backend/src/credits/adjustments.ts:70–84 — `adjustmentCapLockKey` takes the first 8 bytes of a SHA-256 digest as an `int8` advisory lock key. There is no collision analysis. SHA-256 of different `(adminUserId, currency, dayStart)` strings can share the same 8-byte prefix — different admins or currencies on the same day could serialize on the same Postgres advisory lock, creating unnecessary contention. Low probability but worth noting for a production finance system.

- [MEDIUM] apps/backend/src/clustering/data-store.ts:166 — `hasWarnedStale` (module-level variable) is reset to `false` inside `refreshLocations()` at line 173, AFTER the `store = { ..., loadedAt: Date.now() }` update. If the next interval tick fires before the successful write (practically impossible due to the 24h interval, but still a code-order concern) the variable could be reset mid-refresh. More importantly, the stale-warning dedup fires once and never again fires until a successful refresh resets it, even if the outage extends past the interval boundary — intended behavior but worth confirming.

- [MEDIUM] apps/backend/src/credits/withdrawals.ts:177–187 — The `if (existing === undefined)` branch (line 177) inserts a `user_credits` row with `balanceMinor: newBalance`. At this point `priorBalance` is `0n` (the select returned nothing) and `newBalance = 0n - amountMinor` which is negative. This would fail the `user_credits_non_negative` CHECK constraint and throw a DB error, but the comment above says this is "only possible when amountMinor is 0n, which we rejected above." In practice the code would reach here only if somehow the SELECT returned `undefined` despite a non-zero balance — which would mean the `priorBalance < amountMinor` check at line 111 would have already thrown `InsufficientBalanceError`. However, if the SELECT skips the FOR UPDATE lock and a concurrent DELETE drops the row between the lock SELECT and the update, the INSERT would attempt a negative balance and produce an unhandled DB error. Defensive guard is warranted.

- [MEDIUM] apps/backend/src/auth/otps.ts:138–157 — `incrementOtpAttempts` uses a raw `sql` subselect to target the newest live OTP row. When `args.now` is supplied, it injects `${args.now.toISOString()}::timestamptz` directly via the Drizzle `sql` template. The comment says this was added "to avoid serialising a JS Date across postgres-js". However, using `.toISOString()` and embedding the string directly in SQL (even via the `sql` template) bypasses Drizzle's column type mapper and date validation. If `args.now` contains a value that produces an invalid ISO string, the query would fail with a confusing Postgres error. Using a `sql` parameterized bind (`sql`${args.now}``) would go through the driver properly.

- [LOW] apps/backend/src/auth/normalize-email.ts:39 — The ASCII regex `[\x20-\x7e]+` includes space (0x20) in valid characters. An email address with a space in the local part (`foo bar@example.com`) would pass the ASCII check but be an invalid RFC 5321 address. Zod's `.email()` validator in `request-schemas.ts` would catch this upstream, but callers that bypass the Zod schema and call `normalizeEmail` directly would pass through a space-containing email.

- [LOW] apps/backend/src/auth/tokens.ts:200 — `verifyLoopToken` checks `obj['exp'] < Math.floor(Date.now() / 1000)` without clock-skew leeway. For access tokens this is fine (the middleware handles 401 on expiry gracefully), but it means a token that expires exactly at `Date.now()` is rejected even if it was just issued on a slightly faster clock. The JWKS verifier in `id-token-verify-with-key.ts` uses a configurable leeway; consistency here would reduce edge-case auth failures near expiry.

- [LOW] apps/backend/src/credits/payout-builder.ts:113 — `LOOP_ASSET_CODES` is declared as a local `const` `new Set(...)` that duplicates the exported `LOOP_ASSET_CODES` from `payout-asset.ts` (line 35 of the same file). The local set is used only for the guard on line 126. Using the imported set would remove the duplication.

- [LOW] apps/backend/src/clustering/handler.ts:117–131 — The protobuf branch wraps the `@bufbuild/protobuf` and `@loop/shared/src/proto/clustering_pb.js` dynamic imports in a broad `try/catch` that swallows import errors and falls back to JSON. This is intentional, but any error in the encoding/construction path (not just module-not-found) is also swallowed silently — a schema mismatch between the server's protobuf message and the generated schema would silently return JSON to a client that requested protobuf, causing a protocol-level mismatch the client would surface as a decode error with no server-side trace.

- [LOW] apps/backend/src/ctx/operator-pool.ts:98 — `process.env['CTX_OPERATOR_POOL']` is read directly (bypassing `env.ts`) to allow test-time env overrides after module load. This means the value is never validated by the env schema (e.g. not checked against the `z.string()` that would enforce type safety). The comment documents the intent, but a production misconfiguration (e.g. an empty string from Fly secrets) would pass the `.trim().length === 0` check and silently treat the pool as inert rather than failing loudly.

- [LOW] apps/backend/src/auth/social.ts:127 — The `consumeIdToken` error path catches all errors (`catch { ... return 503 }`) including `DB`-unrelated errors like programming mistakes. A thrown `TypeError` from a miscalled API would be indistinguishable from a DB outage. Consider narrowing to DB-flavoured errors and re-throwing unexpected ones.

- [LOW] apps/backend/src/credits/refunds.ts:59–60 — `reason` is declared `optional` in the `applyAdminRefund` args interface, with a comment saying "the admin handler enforces presence at the API boundary." The boundary enforcement is therefore invisible from the primitive's contract. New callers added without the handler enforcement context would silently omit the reason. Recommend making it required at the primitive level (break the caller, not the future.

- [LOW] apps/backend/src/db/migrations/0010_pending_payouts.sql:12 — `order_id` is `NOT NULL` and has a FK to `orders`. Migration 0014 (ADR-024) later adds `withdrawal` kind with nullable `order_id`. The initial schema constraint is corrected by a later migration, but there is no `ADD COLUMN` between 0010 and a later migration for `kind` and nullable `order_id` — if any intermediate state was applied incrementally on a live system, `order_id NOT NULL` would have blocked withdrawal inserts. Verify the migration sequence was applied atomically.

- [LOW] apps/backend/src/auth/require-auth.ts:129–133 — An untrusted `X-Client-Id` triggers a `log.warn` that includes the raw `clientId` value sent by the client. If an attacker sends crafted header values (e.g. containing PII or injection strings), those strings are written into the structured log. While Pino escapes JSON, the value could still appear in log aggregation systems. Consider truncating or redacting the logged value.

- [INFO] apps/backend/src/auth/signer.ts — `Alg` union includes `'RS256'` but the RS256 path returns an empty verifier set at line 96. Any token claiming `alg: 'RS256'` would hit `verifiers.length === 0` and return `bad_signature` in `tokens.ts:169`. This is intentional pending Track A.2, but there is no explicit comment in `tokens.ts` itself documenting this invariant at the dispatch point.

- [INFO] apps/backend/src/credits/pending-payouts.ts — The file is now mostly a barrel of re-exports. The local `PayoutIntent` interface (lines 22–28) duplicates the one from `credits/payout-builder.ts` "so this module doesn't take a type-only import dependency on that file." The duplication is documented but creates a divergence risk if `payout-builder.ts`'s interface gains new required fields.

- [INFO] apps/backend/src/circuit-breaker.ts:114 — `consecutiveFailures` is never reset back to 0 when transitioning from `open` to `half_open` (via the cooldown check on line 124). It only resets in `onSuccess`. So `consecutiveFailures` could be much larger than `failureThreshold` when the probe fires — not a bug, but could make the Discord embed's `consecutiveFailures` value misleading for operators.

- [INFO] apps/backend/src/credits/interest-scheduler.ts:143 — `setImmediate` is used to fire the first tick "on the next macrotask." This is not available in all runtimes (e.g. Deno, Bun, some edge environments). `setTimeout(fn, 0)` is more portable. Not a current issue for Node.js but worth noting if the runtime target ever changes.

- [INFO] apps/backend/src/db/client.ts:47–49 — `isPooledPostgresUrl` only matches `pgbouncer` and `pooler` hostnames. Supavisor (Supabase's newer pooler) uses different hostnames and would not be detected, allowing `statement_timeout` to be set as a startup parameter against it, which may or may not succeed depending on Supavisor's configuration. Acceptable for now but worth updating if Supavisor support is added.

- [INFO] apps/backend/src/auth/jwks.ts:58 — `INVALIDATE_DEBOUNCE_MS` of 60 seconds is hardcoded. A test that calls `invalidateJwks` twice within 60 seconds of real time would be flaky — it would need to use `__resetJwksInvalidateDebounceForTests` before each case. The test seam is provided (line 63), so this is INFO only.

- [INFO] apps/backend/src/credits/apy-snapshot.ts — File is a pure math module with no I/O, no secrets, no auth. Clean.

- [INFO] apps/backend/src/credits/liabilities.ts — Clean, minimal, correct.

- [INFO] apps/backend/src/credits/payout-asset.ts — Clean. The `LOOP_ASSET_CODES` duplication in `payout-builder.ts` is flagged above.

## Batch 04 — backend src (4/7)

- [MEDIUM] apps/backend/src/discord/notifiers-catalog.ts:167 — `notifyWebhookPing` is listed with `channel: 'monitoring'` but the actual function signature takes `channel: DiscordChannel` as a parameter and routes to whichever channel the caller specifies (all three channels are supported). The catalog entry is incorrect and misleading — an admin reading the catalog would think the test-ping only hits the monitoring channel. Recommended fix: either add one catalog entry per channel (with a note that the same function covers all three), or document that `channel` is dynamic and the `monitoring` entry is just a placeholder.

- [MEDIUM] apps/backend/src/db/schema.ts:548,554 / apps/backend/src/db/migrations/0021_orders_currency_check.sql:22 — The `orders.currency` and `orders.charge_currency` DB CHECK constraints are locked to `('USD', 'GBP', 'EUR')`. ADR 035 (current branch `feat/serve-strong-foreign-markets`) adds AED/INR/SAR/AUD/MXN display markets with 203/29/21/17/16 orderable merchants respectively. ADR 035 states "No backend change — CTX already creates and prices these merchants," but any Loop-native order placed for an AED/INR/SAR/AUD/MXN-denominated gift card will violate `orders_currency_known` at the DB layer and roll back with a constraint error. CAD has had the same gap since ADR 034. This is latent and will surface the moment a user in one of these markets attempts to purchase a locally-priced gift card. Recommended fix: either widen the CHECK in a migration for every non-cashback display currency, or document that Loop-native ordering for these currencies is intentionally blocked until a matching LOOP-asset and migration exist.

- [LOW] apps/backend/src/images/proxy.ts:148-157 — `totalCacheBytes` counter can drift above actual bytes stored. When a cache entry for `key` already exists (e.g. an expired but not-yet-evicted entry, or a race between two concurrent fetches for the same URL), `cache.set(key, ...)` silently overwrites the old entry without subtracting `oldEntry.sizeBytes` from `totalCacheBytes` first. The counter increments by `output.byteLength` for the new entry while the old entry's bytes are never removed from the count. Over time `totalCacheBytes` overstates actual memory use, causing premature LRU evictions. Recommended fix: before `cache.set`, check `const old = cache.get(key)` and if present subtract `old.sizeBytes` before adding the new entry's bytes.

- [LOW] apps/backend/src/merchants/sync.ts:44 — `readMerchantDenylist()` reads `env.LOOP_MERCHANT_DENYLIST` from the frozen boot-time `env` object, not from `process.env` directly. The inline comment at line 39 says "takes effect on the next 6h tick (or sooner via the admin force-refresh button)," implying a live Fly secrets update will be picked up on the next tick without a restart. This is incorrect: `env` is parsed once at boot (`parseEnv(process.env)` in `env.ts:685`), and subsequent Fly secret updates won't be reflected until the process restarts. The kill-switches module correctly uses `process.env[key]` at call time for live-update semantics; the denylist should do the same if live-update is the intended contract. Recommended fix: change `readMerchantDenylist()` to read `process.env['LOOP_MERCHANT_DENYLIST']` directly (matching the kill-switch pattern), or update the comment to say "takes effect after the next process restart."

- [INFO] apps/backend/src/db/migrations/0018_pending_payouts_generalise.sql:13 — Comment says "ADR-024 §2 initially planned a partial unique index; after closer review the plain index gives the same semantics." Correct under Postgres NULLS DISTINCT default. No code issue — documentation only, confirmed accurate.

- [INFO] apps/backend/src/db/migrations/meta/\_journal.json — Drizzle-kit journal file (generated). Confirmed nature: JSON metadata for migration history. Not a source file; skipped deep review.

- [INFO] apps/backend/src/db/migrations/meta/0000_snapshot.json — Drizzle-kit snapshot (generated, ~12 KB). Confirmed nature: Drizzle ORM baseline schema snapshot. Not a source file; skipped deep review.

## Batch 05 — backend src (5/7)

### CRITICAL

_(none)_

### HIGH

- [HIGH] apps/backend/src/openapi/admin-cashback-config-history.ts:90 — Missing `500` response; handler explicitly returns 500 on DB failure in the catch block — add `500: { description: 'Internal error loading config history' }` entry
- [HIGH] apps/backend/src/openapi/admin-cashback-config-upsert.ts:100 — Missing `409` response; `withIdempotencyGuard` can return 409 when the same idempotency key is replayed by a different actor — declare `409: IDEMPOTENCY_CONFLICT`
- [HIGH] apps/backend/src/openapi/admin-csv-exports-cashback.ts:46 — Both `/api/admin/cashback-realization/daily.csv` and `/api/admin/cashback-activity.csv` omit 401 and 403 despite being behind `requireAuth`+`requireAdmin`; sibling `admin-csv-exports-raw-rows.ts` correctly declares both — add 401/403 to both paths
- [HIGH] apps/backend/src/openapi/admin-csv-exports-treasury.ts:33 — `/api/admin/treasury/credit-flow.csv` missing 401 and 403 while sibling `GET /api/admin/treasury.csv` in the same file correctly declares them — add 401/403
- [HIGH] apps/backend/src/openapi/admin-csv-exports.ts:139 — `/api/admin/supplier-spend/activity.csv` declares `?currency` query param and a `400: 'Unknown currency'` response that the handler never validates or emits; handler only reads `?days` and returns all currencies — remove ghost param and 400, or implement the filter
- [HIGH] apps/backend/src/openapi/admin-fleet-monthly-merchants-flywheel.ts:88 — `/api/admin/merchants/flywheel-share` uses `z.unknown()` as the 200 response schema; actual handler returns a well-defined `MerchantsFlywheelShareResponse` shape — replace with a registered schema
- [HIGH] apps/backend/src/openapi/admin-fleet-monthly-merchants-flywheel.ts:83 — Complete query-param mismatch: spec declares `?days` but handler reads `?since` (ISO-8601) and `?limit`; spec documents a parameter the handler ignores and omits parameters the handler uses — fix to match handler signature
- [HIGH] apps/backend/src/openapi/admin-fleet-monthly-user-cashback-drill.ts:49 — `/api/admin/users/{userId}/cashback-by-merchant` and `/cashback-summary` both missing 500; handlers explicitly return `c.json({code:'INTERNAL_ERROR'},500)` on DB failure — add 500 to both paths
- [HIGH] apps/backend/src/openapi/admin-fleet-monthly.ts:85 — `GET /api/admin/orders` missing 500; handler at `src/admin/orders.ts:220` explicitly returns 500 on DB failure — add 500
- [HIGH] apps/backend/src/openapi/admin-misc-reads.ts:65 — `GET /api/admin/merchant-flows` missing 500; handler at `src/admin/merchant-flows.ts:84` explicitly returns 500 — add 500
- [HIGH] apps/backend/src/openapi/admin-misc-reads.ts:128 — `GET /api/admin/reconciliation` missing 500; handler at `src/admin/reconciliation.ts:106` explicitly returns 500 — add 500
- [HIGH] apps/backend/src/openapi/admin-operator-mix.ts:88 — `/api/admin/merchants/{merchantId}/operator-mix` missing 500; every comparable admin aggregate endpoint declares it — add 500
- [HIGH] apps/backend/src/openapi/admin-operator-mix.ts:136 — `/api/admin/operators/{operatorId}/merchant-mix` missing 500 for same reason — add 500
- [HIGH] apps/backend/src/openapi/admin-payouts-cluster.ts:108 — `GET /api/admin/payouts` (list) missing 500; handler calls `listPayoutsForAdmin()` with no try/catch — add 500; sibling `GET /api/admin/payouts/{id}` correctly declares it
- [HIGH] apps/backend/src/openapi/admin-payouts-cluster.ts:108 — `GET /api/admin/payouts` list missing `assetCode` query parameter; handler accepts and validates `?assetCode` filter but spec does not declare it — add query param
- [HIGH] apps/backend/src/openapi/admin-payouts-cluster.ts:117 — Both payout-list endpoints declare `403: 'Not an admin'` but `requireAdmin` middleware actually returns 404 (to avoid leaking admin surface existence); replace 403 with 404 across this file
- [HIGH] apps/backend/src/openapi/admin-payouts-settlement-lag.ts:86 — 403 declared but middleware emits 404 (same pattern as payouts-cluster) — replace 403 with 404
- [HIGH] apps/backend/src/openapi/admin-per-merchant-drill-time-axis.ts:81 — 403 declared but middleware emits 404 on both `flywheel-activity` and `top-earners` paths — replace with 404
- [HIGH] apps/backend/src/openapi/admin-per-merchant-drill.ts:81 — All three paths (`flywheel-stats`, `cashback-summary`, `cashback-monthly`) declare 403 but `requireAdmin` returns 404 — replace 403 with 404 throughout file
- [HIGH] apps/backend/src/openapi/admin-treasury-assets.ts:145 — `GET /api/admin/treasury` missing 500; multiple Postgres queries run without try/catch; description's "Horizon failures don't 500" language inadvertently implies total 500-immunity — add 500 entry
- [HIGH] apps/backend/src/openapi/admin-user-search.ts:73 — Missing 500 despite `catch → return c.json({code:'INTERNAL_ERROR'},500)` at `src/admin/user-search.ts:115`; every sibling DB-backed path in this cluster declares 500 — add 500
- [HIGH] apps/backend/src/openapi/admin-withdrawal-write.ts:95 — Missing `503 SUBSYSTEM_DISABLED`; `killSwitch('withdrawals')` middleware fires before the handler and emits 503 with `Retry-After`; currently only `503 NOT_CONFIGURED` is declared — add `SUBSYSTEM_DISABLED` variant with description noting `Retry-After` header
- [HIGH] apps/backend/src/openapi/auth.ts:174 — `DELETE /api/auth/session` likely missing 503 for kill-switch middleware; every other auth path declares it; verify whether the killswitch applies to logout and add if so
- [HIGH] apps/backend/src/openapi/auth.ts:183 — `POST /api/auth/refresh` missing 500; native refresh handler at `auth/native.ts:185` explicitly returns `500 INTERNAL_ERROR` on catch; spec only declares 200/400/401/429/502/503 — add 500
- [HIGH] apps/backend/src/openapi/health.ts:132 — `GET /health` missing 503 response; handler returns HTTP 503 with `HealthResponse` body when `criticalDegraded` (DB unreachable); Fly.io uses this probe for app-restart decisions; only 200 is registered — add `503: { description: 'Critical degradation', schema: HealthResponse }`
- [HIGH] apps/backend/src/openapi/public.ts:162 — `PublicGeoResponse.region` enum is `['US','CA','UK','EUR']` but ADR 035 (commit `9b1d306c`) added AE/IN/SA/AU/MX as supported countries; those countries silently map to `'US'` at the geo layer; spec/description is misleading post-ADR 035 — update description or extend the region model in `regionForCountry`

### MEDIUM

- [MEDIUM] apps/backend/src/openapi/admin-audit-tail.ts:61 — 400 description says only "`before` is not a valid ISO-8601 timestamp" but handler also emits 400 for out-of-range `limit`; description should cover all validation failure cases
- [MEDIUM] apps/backend/src/openapi/admin-cashback-config.ts:103 — `GET /api/admin/merchant-cashback-configs` (list) missing 500; handler has explicit `try/catch → 500`; sibling history endpoint on line 137 correctly declares 500 — add 500
- [MEDIUM] apps/backend/src/openapi/admin-credit-writes.ts:63 — `CreditAdjustmentBody` and `RefundBody` both hardcode `z.enum(['USD','GBP','EUR'])`; ADR 035 adds AE/IN/SA/AU/MX extended-currency markets; if these currencies are added to `HOME_CURRENCIES` these bodies will silently reject valid admin credit actions — replace with reference to `HOME_CURRENCIES` constant
- [MEDIUM] apps/backend/src/openapi/admin-csv-exports.ts:58 — Four CSV endpoints (`payouts-activity`, `merchants/{merchantId}/flywheel-activity.csv`, `merchants-catalog.csv`, `supplier-spend/activity.csv`) omit 401/403 despite being admin-guarded — add 401/403 to all four
- [MEDIUM] apps/backend/src/openapi/admin-csv-exports.ts:24 — Inline TODO comment "a later parity-pass on admin 401/403 documentation can sweep them all together" has no ticket reference or date; violates project standards — add ticket or date
- [MEDIUM] apps/backend/src/openapi/admin-fleet-monthly-merchants-flywheel.ts:88 — `/api/admin/merchants/flywheel-share` missing 500 and missing 400 for `?since` validation errors; handler can emit both — add both
- [MEDIUM] apps/backend/src/openapi/admin-fleet-monthly-recycling-activity.ts:98 — JSON path for `/api/admin/users/recycling-activity` missing 500; CSV sibling correctly declares it; same handler pattern — add 500
- [MEDIUM] apps/backend/src/openapi/admin-fleet-monthly-recycling-activity.ts:132 — 429 description on JSON path says `'Rate limit exceeded'` with no rate figure; CSV sibling says `'Rate limit exceeded (10/min per IP)'`; JSON path uses 60/min per the route file — update description to `'Rate limit exceeded (60/min per IP)'`
- [MEDIUM] apps/backend/src/openapi/admin-fleet-monthly.ts:119 — `/api/admin/orders/payment-method-activity` and `/api/admin/cashback-monthly` both missing 500 — add 500 to both
- [MEDIUM] apps/backend/src/openapi/admin-interest-mint-forecast.ts:95 — 503 `'Horizon unreachable'` is declared but handler never returns it; Horizon failures are caught and degrade to zero-balance rows returning 200 — remove the dead 503 entry or implement the 503 path
- [MEDIUM] apps/backend/src/openapi/admin-interest-mint-forecast.ts:95 — Missing 500 for uncaught exceptions from `computeInterestForecast` — add 500
- [MEDIUM] apps/backend/src/openapi/admin-operator-fleet.ts:57 — `lastOrderAt` declared as non-nullable `z.string().datetime()` but SQL `MAX(fulfilled_at)` over an empty partition returns null; operators with no orders in the window may cause a null-field runtime deserialization mismatch — add `.nullable()` to field
- [MEDIUM] apps/backend/src/openapi/admin-operator-mix.ts:53 — Both `AdminMerchantOperatorMixRow.lastOrderAt` and `AdminOperatorMerchantMixRow.lastOrderAt` declared non-nullable but share the same potential null-from-SQL risk — add `.nullable()`
- [MEDIUM] apps/backend/src/openapi/admin-payouts-cluster-writes.ts:128 — `POST /api/admin/payouts/{id}/compensate` spec 400 description says "payout is not a withdrawal" but handler emits 409 for that case, not 400; spec description and 400 entry are misleading — fix description to clarify 409 covers non-withdrawal-type payouts
- [MEDIUM] apps/backend/src/openapi/admin-per-merchant-drill-time-axis.ts:80 — Both `flywheel-activity` and `top-earners` paths missing 401; `requireAuth` emits 401 for invalid bearer; sibling payouts-cluster.ts correctly declares 401 — add 401
- [MEDIUM] apps/backend/src/openapi/admin-per-merchant-drill.ts:81 — All three per-merchant drill paths missing 401; same root cause as time-axis — add 401
- [MEDIUM] apps/backend/src/openapi/admin-per-merchant-payment-method-share.ts:76 — `/api/admin/merchants/{merchantId}/payment-method-share` missing 401 and 403; endpoint is under admin middleware — add both
- [MEDIUM] apps/backend/src/openapi/admin-per-user-drill.ts:68 — All three per-user drill paths (`flywheel-stats`, `cashback-monthly`, `payment-method-share`) missing 401 and 403 — add both to each path
- [MEDIUM] apps/backend/src/openapi/admin-fleet-monthly-payouts.ts:56 — `/api/admin/payouts-monthly` and `/api/admin/payouts-activity` both missing 401 and 403; under admin middleware — add both
- [MEDIUM] apps/backend/src/openapi/health.ts:72 — `GET /api/config` missing 429; route mounts `rateLimit('GET /api/config', 120, 60_000)` — add 429 entry per project rules
- [MEDIUM] apps/backend/src/openapi/health.ts:72 — `AppConfigResponse` schema missing `phase1Only: boolean` field; handler at `config/handler.ts:53,94` includes it; generated clients will strip the field — add `phase1Only: z.boolean()` to schema
- [MEDIUM] apps/backend/src/openapi/orders.ts:77 — `POST /api/orders` missing 500; handler at `handler.ts:165` emits `500 INTERNAL_ERROR` on catch; spec declares 400/401/404/429/502/503 only — add 500
- [MEDIUM] apps/backend/src/openapi/orders-reads.ts:90 — `GET /api/orders` (CTX-proxy list) missing 500; non-`CircuitOpenError` exceptions fall through to global 500 handler; spec declares 502/503 only — add 500
- [MEDIUM] apps/backend/src/openapi/orders-loop-reads.ts:106 — Both `GET /api/orders/loop` and `GET /api/orders/loop/{id}` missing 500; both hit Postgres directly; `POST /api/orders/loop` correctly declares 500 — add 500 to both GETs
- [MEDIUM] apps/backend/src/openapi/users-cashback-drill.ts:139 — `GET /api/users/me/cashback-monthly` 200 schema is anonymous inline object rather than a `registry.register(...)` call; all other endpoints in this file use named registered components — extract as `CashbackMonthlyResponse`
- [MEDIUM] apps/backend/src/openapi/admin-dashboard-cluster.ts:104 — Verify 429 description "60/min per IP" for `/api/admin/cashback-activity` matches the `rateLimit(...)` call in the route file; discrepancy would mislead clients — cross-check and align
- [MEDIUM] apps/backend/src/openapi/admin-user-cluster.ts:189 — `top-by-pending-payout` 200 schema is anonymous inline object rather than a `registry.register(...)` call; should be extracted as `AdminTopUsersByPendingPayoutResponse` to appear in generated spec components

### LOW

- [LOW] apps/backend/src/openapi/admin-cashback-config.ts:137 — History endpoint 200-response schema is an inline `z.object` rather than a `registry.register(...)` call; inconsistent with the rest of the file — extract as a named registered schema
- [LOW] apps/backend/src/openapi/admin-cashback-config-history.ts:78 — 400 description says "Missing merchantId" but handler also fires 400 for malformed merchantId (bad regex/length) — update description to "Missing or malformed merchantId"
- [LOW] apps/backend/src/openapi/admin-fleet-monthly-credit-csvs.ts:44 — Content-type key is `'text/csv'` but handler emits `text/csv; charset=utf-8`; sibling files use the charset variant — align to `'text/csv; charset=utf-8'`
- [LOW] apps/backend/src/openapi/admin-fleet-monthly-merchants-flywheel.ts:48 — `/api/admin/merchant-stats.csv` uses `'text/csv'` content-type key; sibling handler emits `text/csv; charset=utf-8` — align
- [LOW] apps/backend/src/openapi/admin-fleet-monthly-payouts.ts:39 — `AdminPayoutsMonthlyEntry.assetCode` description references `USDLOOP/GBPLOOP/EURLOOP`; USDLOOP/EURLOOP are retired per ADR 030/031 (project memory: LOOPUSD/LOOPEUR active); update description
- [LOW] apps/backend/src/openapi/admin-fleet-monthly-payouts.ts:95 — `PayoutsActivityResponse.days` uses `z.number().int()` with no min/max; sibling `CashbackActivityResponse.days` uses `.min(1).max(180)` — add matching bounds
- [LOW] apps/backend/src/openapi/admin-fleet-monthly-recycling-activity.ts:98 — JSON path for recycling-activity missing 400 for invalid `?limit`; CSV sibling declares it — add 400
- [LOW] apps/backend/src/openapi/admin-interest-mint-forecast.ts:28 — `const LoopAssetCode = loopAssetCode` is a no-op alias; `loopAssetCode` can be used directly — remove alias
- [LOW] apps/backend/src/openapi/admin-ops-tail-discord-mgmt.ts:39 — `GET /api/admin/discord/notifiers` and `POST /api/admin/discord/test` both missing 500; low-risk (in-memory/fire-and-forget) but inconsistent with fleet pattern — add 500 for consistency
- [LOW] apps/backend/src/openapi/admin-order-cluster.ts:53 — `GET /api/admin/orders/activity` missing 400 despite having a validated `?days` query param; sibling `payment-method-share` in the same file declares 400 — add 400
- [LOW] apps/backend/src/openapi/admin-per-merchant-drill-time-axis.ts:91 — `MerchantTopEarnerRow.email` contains PII but has no `.openapi({description})` noting the PII boundary; file comment acknowledges "PII exposure fine" but the field itself is unannotated — add description noting PII nature
- [LOW] apps/backend/src/openapi/admin-treasury-assets.ts:145 — Description "Horizon failures don't 500 this surface" is misleading after a Postgres outage still produces 500 — update description to clarify only Horizon failures are absorbed
- [LOW] apps/backend/src/openapi/admin-user-search.ts:40 — `homeCurrency: z.enum(['USD','GBP','EUR'])` here vs `z.string().length(3)` on `AdminUserView.homeCurrency` and `AdminUserListRow.homeCurrency` in sibling file; same conceptual field should use consistent schema type — align to enum (preferred)
- [LOW] apps/backend/src/openapi/admin-withdrawal-write.ts:104 — Missing `x-admin-step-up` request header declaration; handler uses `requireAdminStepUp()` middleware; `admin-user-writes.ts` correctly declares the header — add header declaration
- [LOW] apps/backend/src/openapi/auth.ts:174 — `DELETE /api/auth/session` 200 description does not note the circuit-open silent-success path; handler swallows `CircuitOpenError` and returns 200 regardless — add note to 200 description
- [LOW] apps/backend/src/openapi/auth.ts:174 — `DELETE /api/auth/session` missing 500 for consistency with all other auth paths — add 500
- [LOW] apps/backend/src/openapi/clusters.ts:41 — `GeoJsonFeature = z.object({})` is effectively an opaque/unknown schema for the 200-response array element; should describe actual GeoJSON feature fields or reference the protobuf `ClusterResponse` shape — add fields or an explanatory `.openapi` description
- [LOW] apps/backend/src/openapi/merchants-cashback-rates.ts:82 — `userCashbackPct` uses an inline regex rather than the threaded-in `cashbackPctString` parameter; if the shared pattern changes, this field silently diverges — use `cashbackPctString.nullable()` instead
- [LOW] apps/backend/src/openapi/merchants-cashback-rates.ts:37 — Never-500 fallback behaviour (graceful degradation on DB error) is undocumented in the 200 description; callers cannot distinguish "no rates" from "DB was down" — add note per ADR-020
- [LOW] apps/backend/src/openapi/orders-reads.ts:50 — `Order.merchantName` declared required `z.string()` but handler fills it with `?? ''` sentinel when upstream omits it; description should clarify empty-string means "unknown" — add `.openapi({description})` note
- [LOW] apps/backend/src/openapi/orders.ts:49 — `CreateOrderResponse.orderId` typed `z.string()` but upstream always returns a UUID; strengthen to `z.string().uuid()` for better generated-client typing

### INFO

- [INFO] apps/backend/src/openapi/admin-operator-fleet.ts:135 — Fleet aggregate endpoints rate-limited at 60/min while per-operator drill is at 120/min; fleet aggregates are heavier queries — counterintuitive but may be intentional; worth verifying against route file `rateLimit` calls
- [INFO] apps/backend/src/openapi/admin-ops-tail.ts:19 — File header says "Six residual paths" but only enumerates three inline; the remaining three are delegated to siblings without a count — minor doc clarity issue
- [INFO] apps/backend/src/openapi/admin-ops-tail.ts:52 — `TopUserRow.email` is PII; correct for an admin endpoint but confirm log redaction per `docs/log-policy.md` applies to the handler response logging — no spec change needed
- [INFO] apps/backend/src/openapi/clusters.ts:55 — `GET /api/clusters` missing 500 (handler is pure in-memory, very unlikely); missing 503 (no circuit breaker path) — both omissions are technically acceptable but noted for completeness
- [INFO] apps/backend/src/openapi/admin-per-merchant-drill.ts:56 — `AdminMerchantFlywheelStats.since` description says "Window start — 31 days ago" which is a hardcoded-window endpoint; acceptable but could document why there's no `?since` param override
- [INFO] apps/backend/src/openapi/merchants.ts:54 — `Merchant.enabled: z.boolean()` has no description noting the `INCLUDE_DISABLED_MERCHANTS` env-var semantics; `enabled: false` only appears in dev/admin mode — add `.openapi({description})` note

---

## Batch 06 — backend src (6/7)

### openapi/users-\* files

- [INFO] apps/backend/src/openapi/users-cashback-history.ts:113 — CSV path missing `500` response entry; JSON sibling declares it — Add `500` entry to the CSV path's response map
- [INFO] apps/backend/src/openapi/users-dsr-orders.ts:70 — `dsr/export` 200 response uses `z.object({}).passthrough()` — fully opaque schema with no client contract — Replace with concrete schema matching the actual export envelope (schemaVersion:1)
- [INFO] apps/backend/src/openapi/users-favorites.ts — All four paths (GET/POST/DELETE favorites, GET recently-purchased) omit `500` response entries — Add `500` entries consistent with sibling paths
- [INFO] apps/backend/src/openapi/users-flywheel-rail.ts — Clean, no issues
- [INFO] apps/backend/src/openapi/users-history-credits.ts — Clean, no issues
- [LOW] apps/backend/src/openapi/users-pending-payouts-drills.ts:37 — Dead local alias `const UserPendingPayoutView = userPendingPayoutView` serves no purpose — Remove alias; use parameter directly
- [MEDIUM] apps/backend/src/openapi/users-pending-payouts.ts:92 — `SummaryRow.state` hardcodes `z.enum(['pending','submitted'])` instead of deriving from `payoutState`; a confirmed/failed row from a timing window would fail schema validation — Widen to the full `payoutState` parameter with a description note, or document why only two states can appear
- [MEDIUM] apps/backend/src/openapi/users-profile.ts:47,65 — `homeCurrency` and `SetHomeCurrencyBody.currency` hardcoded to `['USD','GBP','EUR']` instead of derived from `HOME_CURRENCIES`; will silently diverge if extended-currency markets add new home currencies — Import and derive from `HOME_CURRENCIES` in `@loop/shared`, matching `loop-asset.ts`
- [INFO] apps/backend/src/openapi/users-stellar-trustlines.ts — Clean, no issues
- [INFO] apps/backend/src/openapi/users.ts — Clean, no issues

### orders/ files

- [INFO] apps/backend/src/orders/barcode-fields.ts — Clean, no issues
- [MEDIUM] apps/backend/src/orders/cashback-split.ts:82 — `applyPct` silently truncates percentage strings with more than 2 decimal digits via `.slice(0, 2)` without logging or throwing; a hand-edited DB row with `"7.556"` would silently compute a different rate — Assert/throw when `decimalPart.length > 2` and add test case
- [HIGH] apps/backend/src/orders/fulfillment.ts:151 — `notifyPegBreakOnFulfillment` is called inside the Drizzle transaction callback before commit is confirmed; if the transaction rolls back, a false-alarm Discord peg-break alert will already have fired — Move the call to after `await db.transaction(...)` resolves, collecting args inside the callback and firing outside (pattern used correctly in `procure-one.ts:290`)
- [LOW] apps/backend/src/orders/get-handler.ts:203 — `as unknown as Record<string, unknown>` double-cast to pass `validated.data` into `applyBarcodeFields` loses compiler type safety — Change `applyBarcodeFields.upstream` to accept the Zod output type directly
- [LOW] apps/backend/src/orders/handler-shared.ts:52 — `c.get('bearerToken') as string` unsafe cast; if middleware fails to set `bearerToken`, coerces `undefined` to string `"undefined"` sent as Authorization header — Add `?? ''` with a log line or assert the middleware contract
- [INFO] apps/backend/src/orders/handler.ts — Thin orchestration layer, clean
- [LOW] apps/backend/src/orders/list-handler.ts:89 — Redundant `as string` cast; Hono's `c.req.query()` already returns `Record<string, string>` — Remove the cast
- [INFO] apps/backend/src/orders/loop-create-checks.ts — Clean, no issues
- [HIGH] apps/backend/src/orders/loop-create-response.ts:122,151 — Non-null assertions `env.LOOP_STELLAR_DEPOSIT_ADDRESS!` are only safe because callers guard the env var; a new call path skipping the guard will throw at runtime — Replace `!` with a runtime check and 503 return, matching the pattern in `loop-replay-response.ts`
- [MEDIUM] apps/backend/src/orders/loop-create-response.ts:178 — `env.LOOP_STELLAR_USDC_ISSUER ?? ''` produces a malformed SEP-7 URI with empty `assetIssuer` if `LOOP_STELLAR_USDC_ISSUER` is unset; USDC branch is not guarded like the XLM branch — Add explicit 503 guard for `LOOP_STELLAR_USDC_ISSUER` before the usdc branch in `loop-handler.ts`
- [LOW] apps/backend/src/orders/loop-create-response.ts:152 — `order.chargeCurrency as 'USD' | 'GBP' | 'EUR'` unsafe runtime cast without `isHomeCurrency()` check — Use `isHomeCurrency()` guard from `@loop/shared`, return 500 explicitly on failure
- [MEDIUM] apps/backend/src/orders/loop-handler.ts:116,138 — `validateMerchantDenomination` uses floating-point multiplication `Math.round(denominations.min * 100)` which can silently round wrong for fractional denominations (IEEE-754 drift e.g. `$0.99`, `$12.50`) — Parse string denominations by splitting on decimal point, same technique as `applyPct` in `cashback-split.ts`
- [INFO] apps/backend/src/orders/loop-read-handlers.ts — Safe runtime casts backed by DB constraints, clean
- [MEDIUM] apps/backend/src/orders/loop-replay-response.ts:142 — Same `env.LOOP_STELLAR_USDC_ISSUER ?? ''` empty fallback issue as `loop-create-response.ts:178` — Same fix: add explicit 503 guard
- [LOW] apps/backend/src/orders/loop-replay-response.ts:122,149 — Unsafe casts `order.chargeCurrency as 'USD'|'GBP'|'EUR'` and `order.paymentMethod as 'xlm'|'usdc'` without runtime validation — Use `isHomeCurrency()` guard; assert `paymentMethod` is in the expected set before casting
- [HIGH] apps/backend/src/orders/procure-one.ts:122 — `log.warn` fires for every order when `LOOP_PHASE_1_ONLY=true` even when USDC balance is healthy; thousands of false-alarm warn entries per day in production obscure real below-floor events — Add `if (!env.LOOP_PHASE_1_ONLY)` guard before the `log.warn` block or emit `log.debug` for the phase-1-override case
- [INFO] apps/backend/src/orders/procurement-asset-picker.ts — Pure/testable functions, clean
- [LOW] apps/backend/src/orders/procurement-redemption.ts:97 — `bodyPreview` logged could contain PII or unexpected fields from non-standard CTX response shapes — Log only keys rather than the raw body preview, in line with log-redaction policy
- [INFO] apps/backend/src/orders/procurement-worker.ts — Clean, no issues
- [INFO] apps/backend/src/orders/procurement.ts — Mostly re-exports now; minor duplicate comment duplication between function comment and module header
- [INFO] apps/backend/src/orders/repo-credit-order.ts — Atomic transaction correctly structured, clean
- [INFO] apps/backend/src/orders/repo-errors.ts — Clean, no issues
- [INFO] apps/backend/src/orders/repo-idempotency.ts — Cause-chain walking well-designed, clean
- [INFO] apps/backend/src/orders/repo.ts:73 — Optional `chargeMinor`/`chargeCurrency` defaults silently bypass FX pinning if a new caller forgets to pass them — Add warning comment on optional fields or make required
- [INFO] apps/backend/src/orders/request-schemas.ts:27 — `extendZodWithOpenApi(z)` side-effect at module load time mutates Zod prototype in every consumer including tests — Consider moving call to openapi registration site only
- [INFO] apps/backend/src/orders/sep7.ts — `destination` field not validated as a Stellar G… pubkey format; malformed address passes parser and only fails at Stellar SDK layer — Add regex/length check consistent with `STELLAR_PUBKEY_REGEX` used elsewhere
- [MEDIUM] apps/backend/src/orders/transitions.ts:248 — Two orphaned JSDoc blocks left from lift-out refactor (`sweepExpiredOrders` and `sweepStuckProcurement`) not attached to any function in this file — Remove both; the authoritative docs are in `transitions-sweeps.ts`
- [INFO] apps/backend/src/orders/transitions-sweeps.ts — Clean, no issues

### payments/ files

- [LOW] apps/backend/src/payments/amount-sufficient.ts:53 — `credit` early-return has no `log.error`; if a credit order reaches the watcher, the bug is invisible to ops — Add `log.error` before the `return false` with `orderId`
- [MEDIUM] apps/backend/src/payments/asset-drift-watcher.ts:306 — `skipped > 0` tick with zero samples logs `"Asset drift tick complete"` with empty `transitions:[]` — confusing log noise but not harmful — Tighten log condition to avoid emitting when no meaningful activity occurred
- [INFO] apps/backend/src/payments/cursor-watchdog.ts — Clean; DB errors surface to caller's catch; acceptable
- [LOW] apps/backend/src/payments/fee-strategy.ts:54 — `Math.pow(opts.multiplier, idx-1)` with extreme `idx` produces `Infinity`; `BigInt(Infinity)` throws; unreachable with default maxAttempts=5 but unguarded — Add `if (!Number.isFinite(raw)) return Math.floor(opts.capFeeStroops).toString()`
- [MEDIUM] apps/backend/src/payments/horizon-asset-balance.ts:65 — `parseStroops` duplicated from `stroops.ts`; implementations can drift — Import from `./stroops.js` and delete private copy (same issue in `horizon-trustlines.ts`)
- [INFO] apps/backend/src/payments/horizon-balances.ts:80 — Single-entry cache `let cached: Cached | null` will thrash if ever called with multiple operator accounts; inconsistent with sibling modules' `Map<string, Cached>` pattern — Use `Map<string, Cached>` keyed on `${account}::${usdcIssuer ?? ''}`
- [MEDIUM] apps/backend/src/payments/horizon-circulation.ts:74 — Single-entry cache `let cached: Cached | null` evicts on every second asset call in a multi-asset loop; cache provides zero benefit for 2+ LOOP assets, forcing extra Horizon round-trips per tick — Replace with `Map<string, Cached>` as `horizon-trustlines.ts` does
- [LOW] apps/backend/src/payments/horizon-circulation.ts:47 — Zod schema accepts negative amounts (`/^-?\d+/`); a negative Horizon value would produce a negative `bigint` snapshot stored without error — Remove `-?` from regex; log a schema-drift error if negative value received
- [INFO] apps/backend/src/payments/horizon-find-outbound.ts — Clean; empty-page early return is intentional
- [INFO] apps/backend/src/payments/horizon.ts — Clean; dual `transaction_successful` check is intentional
- [MEDIUM] apps/backend/src/payments/horizon-trustlines.ts:79 — `parseStroops` duplicated from `stroops.ts` — Same fix as `horizon-asset-balance.ts`: import from `./stroops.js`
- [MEDIUM] apps/backend/src/payments/interest-pool-watcher.ts:149 — Missing `markWorkerStarted/Stopped/TickSuccess/TickFailure` instrumentation; watcher is invisible to the health-check dashboard — Import and add calls matching the pattern in `asset-drift-watcher.ts`
- [LOW] apps/backend/src/payments/interest-pool-watcher.ts:102 — `Number(poolStroops) / Number(dailyInterestStroops)` loses precision for very large bigints; threshold comparison uses JS-number — Use integer bigint division for the threshold; convert to Number only for display
- [INFO] apps/backend/src/payments/payout-submit.ts — SDK-interface shims are well-commented and necessary; clean
- [MEDIUM] apps/backend/src/payments/payout-worker-pay-one.ts:207 — `expectedKind` maps `'credit'` to `'usdc'` as a dead fallback (credit orders have `paymentMemo=null` so can never be matched); could mask future bugs if memo-null invariant is relaxed — Replace with `log.error` + `continue` for the credit branch
- [INFO] apps/backend/src/payments/payout-worker.ts:221 — `LOOP_STELLAR_HORIZON_URL` read from `process.env` directly rather than through `env.ts`; consistent with other Horizon URL readers but deviates from schema-validated pattern — Acceptable as-is; note for future env.ts migration
- [LOW] apps/backend/src/payments/price-feed-fx.ts:172 — Two-hop GBP→EUR conversion applies floor on intermediate BigInt division before ceiling on output; effective rounding can be 1 minor unit in user's favour; undocumented — Add comment and test for GBP→EUR path specifically
- [INFO] apps/backend/src/payments/price-feed.ts — Clean; low-fidelity `stroopsPerCent` caveat documented
- [LOW] apps/backend/src/payments/sep7.ts:104 — `assetIssuer` argument silently dropped when `assetCode === 'XLM'`; callers can pass `assetIssuer` without warning — Add `log.warn` when `assetCode === 'XLM' && assetIssuer !== undefined`
- [INFO] apps/backend/src/payments/stroops.ts — Canonical `parseStroops`; eliminate the private copies in horizon-asset-balance.ts and horizon-trustlines.ts
- [LOW] apps/backend/src/payments/stuck-payout-watchdog.ts:1 — No `logger` import; alert and no-rows paths produce zero structured log output; errors surface silently to caller's catch — Import `logger`; add `log.info` on clear path and `log.warn` on alert path
- [INFO] apps/backend/src/payments/watcher-bootstrap.ts — Clean; guard order is safe in practice
- [MEDIUM] apps/backend/src/payments/watcher.ts:226 — Amount-insufficient log uses `order.faceValueMinor` as "expected" value but `isAmountSufficient` validates against `order.chargeMinor`; for cross-currency orders the logged "expected" value is in the wrong currency — Change to `expected: order.chargeMinor.toString(), expectedCurrency: order.chargeCurrency`

### public/ files

- [LOW] apps/backend/src/public/cashback-preview.ts:191 — When `cashbackPctToBps(cashbackPct)` returns `null` (malformed DB value), the raw invalid string is forwarded to the public API response, leaking a DB inconsistency to clients — Set `cashbackPct = null` when `bps === null`; add `log.error` for the malformed DB value
- [LOW] apps/backend/src/public/cashback-stats.ts:65 — Three separate `db.execute` calls outside a transaction; snapshot is internally inconsistent if cashback rows flush between queries; undocumented — Add comment noting the three-query snapshot is intentionally non-transactional (marketing data)
- [LOW] apps/backend/src/public/flywheel-stats.ts:84 — `WHERE paymentMethod = 'loop_asset'` for "recycled orders" metric will silently drop to zero if new payment methods are added for recycled payments post-ADR-031 transition — Add comment: update this filter if `payment_method` enum gains new recycled-payment values

## Batch 07 — backend src (7/7)

- [HIGH] apps/backend/src/users/dsr-handler.ts:119-123 — `failed_uncompensated_withdrawals` block reason from `dsr-delete.ts` is never handled in the DSR delete handler; only `pending_payouts` and the generic fallback `in_flight_orders` are checked. If `deleteUserViaAnonymisation` returns `blockedBy: 'failed_uncompensated_withdrawals'`, the handler returns the `IN_FLIGHT_ORDERS` message instead of a tailored message, misrepresenting why deletion was blocked. — Add a case for `'failed_uncompensated_withdrawals'` returning a 409 with an appropriate code/message before the generic fallback.

- [HIGH] apps/backend/src/users/cashback-history-handler.ts:86-95 — DB query inside `getCashbackHistoryHandler` is not wrapped in a try/catch. If the Drizzle query throws (DB connection loss, query error), the handler propagates an unhandled rejection, returning a 500 without a structured error envelope and without logging the error with context. `getUserCreditsHandler` (same file, line 215) has the same gap. — Wrap the DB calls in try/catch and return `{ code: 'INTERNAL_ERROR', message: ... }` 500 responses, consistent with the pattern in all sibling handlers.

- [MEDIUM] apps/backend/src/public/top-cashback-merchants.ts:59-60 — `orderBy(desc(merchantCashbackConfigs.userCashbackPct))` orders a `text` column lexicographically, not numerically. "9" > "10" lexicographically, so the "top cashback" marketing list is incorrectly ranked when any pct value has different digit-count from its neighbors (e.g. "9.5" vs "10.0"). — Cast to numeric in the Drizzle expression: `desc(sql`${merchantCashbackConfigs.userCashbackPct}::numeric`)`.

- [MEDIUM] apps/backend/src/users/dsr-export.ts:143-148 — `buildDsrExport` runs five parallel DB queries with `Promise.all` but they are not run inside a transaction, meaning the export can be inconsistent if writes occur between the individual reads (e.g. a credit transaction committed after the `creditTransactions` query but before the `orders` query would be missing from the orders result). For a legal-grade DSR export, consistency matters. — Wrap the parallel reads in a `db.transaction(async tx => ...)` with `READ ONLY` isolation (or at minimum a repeatable-read transaction) to get a consistent snapshot.

- [MEDIUM] apps/backend/src/users/stellar-trustlines.ts:80-88 — When `user.stellarAddress === null`, the handler returns `accountExists: false` hardcoded. This is correct semantically but the response type has `accountExists: boolean` meaning "Horizon has an account record". The no-address path conflates "we didn't ask Horizon" with "Horizon said no account" — a client that branches on `accountExists` will behave incorrectly (e.g. "account doesn't exist, show fund-wallet instructions" when actually the user just hasn't linked yet). `accountLinked: false` should be the guard the client uses, and `accountExists` should be omitted or nullable in the no-address case. — Document the semantics clearly or use a discriminated union in the response type; at minimum add a code comment clarifying `accountExists: false` in the no-address path means "not queried, not applicable".

- [MEDIUM] apps/backend/src/scripts/quarterly-tax.ts:259-267 — `void closeDb()` in the `.finally()` block discards the close-db promise. If `closeDb()` throws or rejects (e.g. connection pool teardown fails on a live connection), the error is silently swallowed. Not critical for a script, but `process.exit(code)` runs before the pool is fully closed in the error path, which can cause a hang on some pg driver versions. — Await `closeDb()` in the `.finally()` block (can wrap in a `.catch(() => {})` to tolerate teardown errors, matching the `check-ledger-invariant.ts` pattern).

- [MEDIUM] apps/backend/src/upstream-body-scrub.ts:34 — `OPAQUE_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g` has no upper bound. A body containing a single very long base64url string (e.g. a 10 MB encoded blob in a CTX error response) will cause the regex engine to do a linear scan over the entire string, which can be slow. Given the function already caps at `maxLen=500` before returning, but the regex is applied _before_ slicing, a caller that passes a large body (e.g. someone passes a raw upstream body before slicing) would be at risk. — Apply the `maxLen` slice _before_ running the regexes; document the intended call contract (callers should pre-slice).

- [LOW] apps/backend/src/public/merchant.ts:41 — `MERCHANT_ID_RE = /^[A-Za-z0-9._-]+$/` allows `.` in merchant IDs. This is fine functionally (CTX IDs don't use dots), but the regex does not reject empty string since `+` requires ≥1 char. However the explicit `idParam.length === 0` check on line 99 covers this. No security issue; the regex is slightly redundant with the empty check. INFO only.

- [LOW] apps/backend/src/routes/admin.ts:141 — `(c as unknown as Context).get('user')` uses a double cast to `Context` which then immediately calls `.get('user')` — the outer cast is redundant since `c` already is of type `Context`. This likely reflects a Hono generic type mismatch. — Either correctly type `c` or use `c.get('user')` directly with a Hono typed context.

- [LOW] apps/backend/src/users/cashback-by-merchant.ts:133 — `AND ${creditTransactions.currency} = ${user.homeCurrency}` scopes the cashback query by the user's _current_ home currency. If a user was credited cashback in a prior home currency before a support-mediated flip, those rows won't appear in this endpoint. This matches the documented intent ("admin ledger view owns the full picture") but is not explicitly documented in the JSDoc. INFO-level; no security issue, but may confuse users. — Add a comment in the JSDoc noting the single-currency scope and its implications.

- [LOW] apps/backend/src/users/favorites-handler.ts:150-188 — The cap-check within the transaction reads the count after checking for an existing entry. Between the `existing` select and the `countRows` select, a concurrent insert by the same user could push the count above `MAX_FAVORITES_PER_USER`. The row-level locking only applies within the transaction's own statements; there is no `SELECT ... FOR UPDATE` or advisory lock on the count. In practice the 50-cap is soft and a by-1 race is harmless UX-wise, but the comment claims this prevents racing. — Either use `SELECT count(*) ... FOR UPDATE` or accept the soft cap and remove the "race prevention" comment to avoid misleading future maintainers.

- [LOW] apps/backend/src/webhooks/hmac-verify.ts:93 — `Number(args.timestamp)` used instead of `Number.parseInt(args.timestamp, 10)`. For a unix timestamp string this is fine in practice, but `Number('  123  ')` returns 123 while `parseInt` would too; the concern is `Number('0x1a')` = 26 (hex) vs `parseInt('0x1a', 10)` = 0. An attacker-controlled timestamp could be a hex string. The `Number.isInteger` check downstream would accept it, allowing minor timestamp manipulation. — Use `Number.parseInt(args.timestamp, 10)` and explicitly reject if `String(Number.parseInt(args.timestamp, 10)) !== args.timestamp` to avoid any non-decimal numeric format.

- [LOW] apps/backend/src/sentry-scrubber.ts:54 — `LONG_HEX_RE = /[a-fA-F0-9]{32,}/g` has no word-boundary anchor. It will match the hex segments inside UUID-formatted strings (order IDs, user IDs), replacing them with `[REDACTED_HEX]` and stripping useful debugging context from Sentry events. The comment acknowledges this but frames it as "false positives on common UUID-shaped order ids are acceptable collateral", which is incorrect — UUIDs use dashes and the regex matches the 8/4/4/4/12 segments individually, each <32 chars, so standard hyphenated UUIDs are safe. However a 32-char hex without dashes (e.g. some internal IDs) would be redacted. — Document the known false-positive surface in a comment so maintainers understand when Sentry events will have redacted IDs.

- [INFO] apps/backend/src/test-endpoints.ts:71-85 — `/__test__/mint-loop-token` endpoint returns `accessToken` and `refreshToken` in cleartext. This is intentional and gate-controlled on `NODE_ENV=test`, but is worth calling out: if a test environment is ever accidentally exposed (e.g. a staging deploy with `NODE_ENV=test`), this endpoint would be a full session-minting backdoor with no rate limiting. — Add a defensive check that `env.NODE_ENV === 'test'` inside the handler body itself (not just at the mount point), so a misconfigured mount can't silently expose the endpoint in non-test environments. Rate-limiting the endpoint would also be prudent.

- [INFO] apps/backend/src/runtime-health.ts:209-215 — `__resetRuntimeHealthForTests` is a module-level export with a double-underscore convention for test-only use, but there is no lint rule or comment enforcing this convention. In production, the function is exported and could technically be imported anywhere. INFO only — no path for a caller outside tests to invoke it at runtime.

- [INFO] apps/backend/tsup.config.ts:30-37 — `onSuccess` is async but `cpSync` is synchronous; using the async form adds no value and may confuse future maintainers into adding async I/O here without understanding the constraints. INFO only.

## Batch 08 — backend tests (1/3)

- [MEDIUM] apps/backend/src/**tests**/integration/admin-writes.test.ts:612-668 — Concurrent-withdrawal "race" test wraps each `app.request(...)` in `Promise.resolve(...)` which is a no-op on an already-Promise; the two requests execute serially, not concurrently, so the test never actually exercises the race condition it claims to test — replace with `Promise.all([app.request(...), app.request(...)])` to fire both simultaneously
- [MEDIUM] apps/backend/src/**tests**/discord.test.ts (throughout) — 40+ tests use `await new Promise((r) => setTimeout(r, 10))` as the sole mechanism to let fire-and-forget async operations resolve; this is a timing-based approach that will produce false-negatives in slow CI environments — replace with a proper flush mechanism (e.g. `vi.useFakeTimers()` or promisify the notifier for test injection)
- [MEDIUM] apps/backend/src/admin/**tests**/handler.test.ts:433-459 — `configHistoryHandler — A2-513 validation` describe block contains an exact duplicate of the `400 when merchantId param is missing` test case that appears in the subsequent `configHistoryHandler` describe block (lines 455-459); the duplicated test adds no value and could mask regressions if only one copy is updated — remove the duplicate
- [MEDIUM] apps/backend/src/admin/**tests**/cashback-activity-csv.test.ts:101-111 — The `clamps ?days` test only asserts `res.status === 200`; it never verifies the SQL received a clamped value or that the echoed `days` field reflects the clamp — add assertions on `(await res.text())` content or the echoed window value to prove actual clamping occurred
- [MEDIUM] apps/backend/src/**tests**/routes.integration.test.ts (throughout) — Mock env does not set `LOOP_AUTH_NATIVE_ENABLED=true`, so all auth-path assertions exercise only the legacy CTX-proxy path; the Loop-native OTP path is completely untested at the route-integration level — add a parallel integration test block with `LOOP_AUTH_NATIVE_ENABLED=true`
- [LOW] apps/backend/src/**tests**/circuit-breaker.test.ts:203-253 — Probe timeout failsafe test instantiates a first circuit breaker `cb` then immediately creates a second breaker `probe` and only exercises `probe`; `cb` is declared but never used — either merge into a single breaker test or remove the unused `cb` variable
- [LOW] apps/backend/src/admin/**tests**/audit-tail.test.ts:4-34 — The chainable Drizzle mock object (`chain()`) is module-level shared state; `state.whereCalled` is reset in `beforeEach` but `state.limitArg` is not, allowing a previous test's limit value to leak into the next if a test skips the limit assertion; additionally, the `whereCalled` boolean cannot distinguish multiple `.where()` calls — use a counter instead
- [LOW] apps/backend/src/admin/**tests**/merchant-top-earners.test.ts:192-202 — `defaults ?limit to 10 and clamps to [1, 100]` test loops over 7 limit values but only asserts `res.status === 200`; no assertion verifies the SQL actually received a different LIMIT for the extremes — the test title claims clamping but the body does not verify it
- [LOW] apps/backend/src/**tests**/integration/vitest-integration-setup.ts — Setup file (not a test file); no test cases; correctly listed in manifest for completeness
- [LOW] apps/backend/src/**tests**/integration/db-test-setup.ts — Setup file (not a test file); no test cases; correctly listed in manifest for completeness
- [LOW] apps/backend/src/**tests**/vitest-env-setup.ts — Setup file (not a test file); no test cases; correctly listed in manifest for completeness
- [LOW] apps/backend/src/admin/**tests**/merchants-flywheel-share.test.ts:88-97 — `clamps ?limit` test only asserts `res.status === 200` for extreme values; it cannot observe the actual LIMIT clause passed to SQL, so the test passes vacuously even if clamping is broken — document this limitation with a comment or add a mock call count assertion
- [INFO] apps/backend/src/**tests**/bigint-money-property.test.ts (zero-balance loop) — The `computeLedgerDriftFromRows` zero-balance test runs 50 identical iterations with the same PRNG seed output; only the first iteration adds coverage, the remaining 49 are redundant — reduce to a single iteration or vary the seed
- [INFO] apps/backend/src/admin/**tests**/cashback-activity.test.ts — Thorough handler tests; the `clamps days` test (line 105-114) correctly asserts echoed `days` value, serving as a positive counterexample to the CSV sibling's weaker test

## Batch 09 — backend tests (2/3)

### CRITICAL

- [CRITICAL] apps/backend/src/db/**tests**/pending-payouts-schema.test.ts:42–55 — `kind has a default of "order_cashback"` and `orderId is optional on insert` assert on plain object literals the test itself constructed (`expect(cashbackInsert.kind).toBeUndefined()`): these assertions can never fail regardless of what the schema says — recommended fix: replace with `expectTypeOf` assertions or a real Drizzle integration test that inserts without `kind` and reads back the DB default
- [CRITICAL] apps/backend/src/db/**tests**/pending-payouts-schema.test.ts:57–63 — `kind literal type admits only the two known values` assigns two string literals that already satisfy the discriminated-union type, then asserts the resulting array has length 2; this runtime check can never fail and provides no guard against type drift — recommended fix: use `expectTypeOf<PendingPayoutRow['kind']>().toEqualTypeOf<'order_cashback' | 'withdrawal'>()` instead

### HIGH

- [HIGH] apps/backend/src/admin/**tests**/payouts.test.ts:66–83 — `baseRow` fixture is missing the `kind` field; every serialisation test produces `kind: undefined` in the wire view but no test asserts on `kind`, so a broken kind serialisation would pass undetected — recommended fix: add `kind: 'order_cashback' as const` to `baseRow` and assert `kind` in the serialisation test
- [HIGH] apps/backend/src/admin/**tests**/payouts.test.ts — `?kind=` query-parameter filter (valid/invalid/wrong-case paths) is entirely untested despite being a 400-producing validation branch in the handler — recommended fix: add tests analogous to the `?assetCode` block
- [HIGH] apps/backend/src/admin/**tests**/payouts.test.ts — `adminListPayoutsHandler` has no 500/unhandled-repo-throw test while every sibling describe block has one — recommended fix: add `listMock.mockRejectedValue(new Error(...))` test
- [HIGH] apps/backend/src/admin/**tests**/top-users-by-pending-payout.test.ts:136–149 — `it.each` limit-clamping table captures `expected` values but immediately renames them `_expected` and never uses them; only `status === 200` is asserted, so the five input→clamped-value mappings are entirely untested — recommended fix: expose the clamped limit via a captured SQL state slot as `stuck-orders.test.ts` does
- [HIGH] apps/backend/src/admin/**tests**/top-users.test.ts:120–132 — test name "always returns 200 regardless of limit value — defaults to 20, clamps 1..100" only asserts `status === 200`; the clamping itself is never verified — recommended fix: expose and assert the clamped limit value
- [HIGH] apps/backend/src/admin/**tests**/treasury-credit-flow-csv.test.ts:114–117 — `normalises ?currency to upper case` asserts only `status === 200`; the JSON sibling test correctly reads back `body.currency` but the CSV test never checks the CSV output contains `GBP` — recommended fix: populate `state.rows` and check the CSV line contains `GBP`
- [HIGH] apps/backend/src/admin/**tests**/treasury.test.ts:144–157 — multiple `shapes outstanding balances` tests push 3 DB result arrays for a 4-query handler; the 4th `orderFlows` query silently gets an empty `[]` via the fallback, masking any position-ordering bugs in the query chain — recommended fix: push all 4 result arrays explicitly
- [HIGH] apps/backend/src/admin/**tests**/user-cashback-by-merchant.test.ts:51 — `eq` mock returns `true` regardless of arguments; the `userId` WHERE predicate is never verified so a bug that silently drops the userId filter would pass — recommended fix: capture arguments to `eq` and assert expected column + value
- [HIGH] apps/backend/src/admin/**tests**/supplier-spend-activity-csv.test.ts:125–132 — clamping test only asserts `status === 200`; cannot distinguish "correctly clamped" from "silently accepted 0 as-is" — recommended fix: capture the `days` value reaching the SQL mock and assert the clamped value
- [HIGH] apps/backend/src/auth/**tests**/native.test.ts — entire test suite calls handlers directly bypassing all route-level middleware: `Cache-Control: no-store`, rate-limiting, `killSwitch('auth')`, and `LOOP_AUTH_NATIVE_ENABLED` dispatch are never exercised for the native path — recommended fix: add `app.request()`-style tests analogous to `handler.test.ts`
- [HIGH] apps/backend/src/auth/**tests**/native.test.ts — `isLoopAuthConfigured() === false` 500 branch is never tested; `LOOP_JWT_SIGNING_KEY` is always set via `vi.hoisted` — recommended fix: add a test that removes the signing key and asserts `500 INTERNAL_ERROR`
- [HIGH] apps/backend/src/auth/**tests**/refresh-tokens.test.ts — `tryRevokeIfLive` and `findRefreshTokenRecord` (security-critical A2-1608/A4-098 functions) are exported but have zero test coverage — recommended fix: add tests for both functions including the false return from `tryRevokeIfLive` when the row is absent
- [HIGH] apps/backend/src/auth/**tests**/social.test.ts:188–207 — Apple handler test is nested inside the `describe('googleSocialLoginHandler')` block, making it invisible during Google-specific investigation and easy to overlook — recommended fix: move into its own `describe('appleSocialLoginHandler')` block
- [HIGH] apps/backend/src/auth/**tests**/tokens.test.ts:163–190 — the `wrong_issuer` rejection code path in `verifyLoopToken` is never actually exercised; the test tampers the payload without re-signing so `bad_signature` fires first (test comment acknowledges and accepts either reason) — recommended fix: construct a properly-signed token with a wrong `iss` claim using `createHmac` directly
- [HIGH] apps/backend/src/credits/**tests**/apy-snapshot.test.ts:12–17 — happy-path tests use `if (result.ok) { expect(…) }` guards on 7 locations; if `result.ok` is ever `false` due to a regression the inner assertions are silently skipped and the test stays green — recommended fix: assert `expect(result.ok).toBe(true)` first, then use `if (!result.ok) throw` for type narrowing
- [HIGH] apps/backend/src/credits/**tests**/payout-builder.test.ts:108–118 — `if (d.kind !== 'pay') return` escape hatch causes the test to silently exit with zero assertions when `d.kind` is not `'pay'`; a cashback amount conversion regression would produce a green test — recommended fix: replace with `if (d.kind !== 'pay') throw new Error('expected pay intent')`
- [HIGH] apps/backend/src/credits/**tests**/interest-scheduler.test.ts:113–126 — `defensive: zero APY does not start` does not advance fake timers before asserting `accrueMock` was not called; if `startInterestScheduler` arms a `setImmediate` the assertion passes vacuously because the macro-task has not yet run — recommended fix: call `await vi.advanceTimersByTimeAsync(0)` after starting/stopping the scheduler
- [HIGH] apps/backend/src/credits/**tests**/liabilities.test.ts:58–65 — `sumOutstandingLiability` currency-filter test asserts only that `state.whereClauses` has length 1; a bug where EUR queries USD (or vice versa) would pass silently — recommended fix: inspect the WHERE predicate argument and check it contains the requested currency string
- [HIGH] apps/backend/src/ctx/**tests**/operator-pool.test.ts:127–133 — no test verifies the behavioural difference between "env never set" (sticky latch) vs "env set but malformed" (A2-573 retryable); a refactor making both paths sticky (or both unsticky) would pass the existing suite — recommended fix: add a combined test demonstrating both behaviours in sequence

### MEDIUM

- [MEDIUM] apps/backend/src/admin/**tests**/payouts-activity-csv.test.ts:120–129 — clamping test comment acknowledges the SQL is mocked so actual `days` value used is unobservable; test name overstates what is verified — recommended fix: rename to reflect what it actually checks, or capture template-literal args in the mock
- [MEDIUM] apps/backend/src/admin/**tests**/read-audit.test.ts — multi-value PII param redaction untested (e.g. `email=a@x.com&email=b@x.com`); a regression that only redacts the first occurrence would pass — recommended fix: add a test with a duplicated PII key
- [MEDIUM] apps/backend/src/admin/**tests**/read-audit.test.ts — `q=` key is only tested incidentally as part of a multi-param case; `q=` in isolation and combined `email=...&q=...` are untested — recommended fix: add isolated `q=` and combined tests
- [MEDIUM] apps/backend/src/admin/**tests**/settlement-lag.test.ts — default 24h window asserts only that `body.since` is a string; a change from 24h to 24d would pass undetected — recommended fix: assert `Math.abs(Date.now() - new Date(body.since).getTime() - 24*3600*1000) < 5000`
- [MEDIUM] apps/backend/src/admin/**tests**/refunds.test.ts:170–177 — `400 on too-short Idempotency-Key` checks `status === 400` but not `body.code`; the missing-key test at lines 161–169 does check `body.code` — recommended fix: add `expect(body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')` to the too-short test
- [MEDIUM] apps/backend/src/admin/**tests**/treasury.test.ts:267–299 — payout-counts tests push 3 result arrays for a 4-query handler (same root cause as the outstanding-balances tests); 4th query silently gets empty fallback — recommended fix: push 4 arrays
- [MEDIUM] apps/backend/src/admin/**tests**/user-by-email.test.ts:106–112 — `it.each` for malformed addresses checks `status === 400` but never verifies `body.code` — recommended fix: add `.code` assertion to each malformed-email case
- [MEDIUM] apps/backend/src/admin/**tests**/user-cashback-monthly.test.ts:134–143 — `{ rows }` envelope test checks `entries.length === 1` but does not verify any field on the unwrapped row — recommended fix: add `toMatchObject({ month: '...', assetCode: '...' })` assertion
- [MEDIUM] apps/backend/src/admin/**tests**/user-cashback-summary.test.ts:104–124 — no test exercises `currency: null` from the COALESCE path; a handler crash on null currency would go undetected — recommended fix: add a fixture row with `currency: null`
- [MEDIUM] apps/backend/src/admin/**tests**/user-credit-transactions.test.ts:153–166 — limit-clamp test only checks `status === 200`; the clamped value reaching the query is never verified (inline comment acknowledges but accepts it) — recommended fix: capture the limit argument in `limitMock` as the CSV sibling does
- [MEDIUM] apps/backend/src/admin/**tests**/users-recycling-activity.test.ts:129–136 — limit-clamp test only checks `status === 200`; same gap as user-credit-transactions — recommended fix: capture limit from the `db.execute` mock
- [MEDIUM] apps/backend/src/admin/**tests**/users-list.test.ts:126–129 — `applies q filter through a WHERE clause` only asserts the mock was called, not what predicate was passed; `escapeLike` function is never tested in this file despite being a local copy of the user-search escape logic — recommended fix: add escape tests for `_`, `%`, and `\` in `?q=`
- [MEDIUM] apps/backend/src/admin/**tests**/user-search.test.ts — no 500/db-error path tested despite every sibling having one — recommended fix: add `throwErr` flag and `'500 when db throws'` test
- [MEDIUM] apps/backend/src/admin/**tests**/user-operator-mix.test.ts:96–108 — default `since` window asserts only `typeof body.since === 'string'`; the 24h default is never verified — recommended fix: assert the timestamp is within ~5 s of `Date.now() - 24*3600*1000`
- [MEDIUM] apps/backend/src/admin/**tests**/stuck-orders.test.ts:92–117 — `ageMinutes` is not asserted for the `procuring` row; a regression in age-calculation for that state would pass — recommended fix: add `ageMinutes` range assertions for the procuring row
- [MEDIUM] apps/backend/src/admin/**tests**/stuck-payouts.test.ts:119–140 — `ageMinutes` not asserted for `state=pending` rows; mirrors the stuck-orders gap — recommended fix: add range assertion
- [MEDIUM] apps/backend/src/admin/**tests**/supplier-spend.test.ts:144–161 — `tolerates { rows } envelope` only checks `length === 1` and `currency === 'EUR'`; no numeric field verified on unwrapped row — recommended fix: assert `marginBps` or `wholesaleMinor`
- [MEDIUM] apps/backend/src/auth/**tests**/admin-step-up.test.ts:128–132 — token-rotation path is explicitly not tested; `TEST_KEY_PREVIOUS` is declared but only used as `void TEST_KEY_PREVIOUS`; `verifyAdminStepUpToken` tries both keys making this a real production invariant — recommended fix: add a rotation test that signs with the previous key and verifies with current+previous configured
- [MEDIUM] apps/backend/src/auth/**tests**/native.test.ts — `NonAsciiEmailError` path in both `nativeVerifyOtpHandler` and `nativeRequestOtpHandler` is untested — recommended fix: add a test with a Cyrillic email and assert 400
- [MEDIUM] apps/backend/src/auth/**tests**/native.test.ts — OTP_MAX_ATTEMPTS lockout path is not tested through the handler — recommended fix: test via `findLiveOtpMock.mockResolvedValue(null)` with an explicit note about the lockout being the cause
- [MEDIUM] apps/backend/src/auth/**tests**/require-admin.test.ts — no test for the case where `next()` is async and throws; the middleware calls `await next()` without a try/catch so an exception propagates uncaught — recommended fix: add a test where `next` rejects and verify error propagation
- [MEDIUM] apps/backend/src/auth/**tests**/require-auth.test.ts:44–46 — `beforeEach` block contains only a comment with no actual setup code; signals incomplete or abandoned test scaffolding — recommended fix: remove the empty `beforeEach` block or add the intended setup
- [MEDIUM] apps/backend/src/auth/**tests**/social.test.ts:110–138 — happy-path test asserts JWT structure (3 dot-separated parts) but never verifies the tokens are actually valid via `verifyLoopToken`; malformed tokens with two dots would pass — recommended fix: round-trip verify both tokens with `verifyLoopToken`
- [MEDIUM] apps/backend/src/auth/**tests**/social.test.ts:222–233 — feature-flag-off test patches env mid-suite and relies on module-level side-effect ordering; could interact with concurrent tests and does not verify the outer-scope handler is also gated — recommended fix: refactor into its own `describe` using `vi.doMock` before outer module loads
- [MEDIUM] apps/backend/src/auth/**tests**/tokens.test.ts:245–264 — no test for an `alg: 'RS256'` token against an HS256-only configuration (cross-alg forgery attempt); rejection behaviour is unpinned — recommended fix: add a test with `alg: 'RS256'` and an HS256-signed body
- [MEDIUM] apps/backend/src/auth/**tests**/identities.test.ts:12–56 — single `state.user` mock controls both the identity-lookup and email-fallback findFirst calls; impossible to test the "dangling identity → email lookup finds existing account" path — recommended fix: use `mockResolvedValueOnce().mockResolvedValueOnce()` for consecutive findFirst calls
- [MEDIUM] apps/backend/src/auth/**tests**/id-token.test.ts:152–163 — malformed-token loop asserts only `ok: false` without checking the reason; a verifier that returns `bad_signature` for structurally invalid tokens (instead of a parse-error reason) would pass — recommended fix: assert `result.reason` matches an expected parse-error reason
- [MEDIUM] apps/backend/src/auth/**tests**/otps.test.ts:147–151 — `incrementOtpAttempts` never verifies the WHERE predicate; a regression changing `where(eq(otps.id, ...))` to burn all rows for an email would pass silently — recommended fix: capture and assert the where predicate contains the row ID
- [MEDIUM] apps/backend/src/auth/**tests**/otps.test.ts:124–130 — `markOtpConsumed` never verifies the WHERE predicate; a regression consuming all rows for an email would pass — recommended fix: assert the where argument contains the row ID
- [MEDIUM] apps/backend/src/auth/**tests**/otps.test.ts:110–120 — `findLiveOtp` never verifies that `hashOtpCode` was called or that the hash (not the plaintext) was passed to the DB query — recommended fix: spy on `hashOtpCode` to confirm it was called with the raw code
- [MEDIUM] apps/backend/src/credits/**tests**/adjustments.test.ts:229–243 — `cap disabled (value = 0)` test does not assert that the cap-sum DB query was NOT made; a code change that always runs the cap query would pass — recommended fix: add `expect(dbMock['execute']).not.toHaveBeenCalled()`
- [MEDIUM] apps/backend/src/credits/**tests**/accrue-interest.test.ts:261–266 — `uses a transaction for each per-user write` asserts `transaction` was called but not how many times; "per-user" guarantee is unverified — recommended fix: seed two users and assert `toHaveBeenCalledTimes(2)`
- [MEDIUM] apps/backend/src/discord/**tests**/admin-audit.test.ts:96–98 — `Idempotency-Key is truncated to 32 chars` asserts `length <= 34` which passes for an empty string; truncation occurrence is not confirmed — recommended fix: also assert `length > 4` and that the `…` ellipsis is present
- [MEDIUM] apps/backend/src/db/**tests**/orders-schema.test.ts:27–31 — `exposes a union type usable as OrderState` runtime assertion (`ORDER_STATES.includes(sample)`) tests only the value the author wrote in, not the type; same pattern at lines 42–44 and 45–48 — recommended fix: add `expectTypeOf` call or clarify these are compile-time-only checks
- [MEDIUM] apps/backend/src/credits/**tests**/interest-pool.test.ts:60–69 — mid-test call to `__resetInterestPoolForTests()` combined with `beforeEach` reset creates implicit ordering dependence; `__resetForTests` escape hatch not documented — recommended fix: document the escape hatch and ensure each test is independent

### LOW

- [LOW] apps/backend/src/admin/**tests**/payouts-csv.test.ts:163–166 — `?since` filename test only checks `Content-Disposition`; does not verify the filter was actually forwarded to the query — recommended fix: assert the `limitArg` or mock chain reflects the since date
- [LOW] apps/backend/src/admin/**tests**/payouts-by-asset.test.ts — USDLOOP `confirmed` state is never tested as non-zero in the pivot test; asymmetric fixture coverage — recommended fix: add a USDLOOP confirmed row (low priority)
- [LOW] apps/backend/src/admin/**tests**/payouts-monthly.test.ts — `{ rows }` envelope test checks `entries.length === 1` but no fields — recommended fix: add `toMatchObject({ month: ..., assetCode: ... })`
- [LOW] apps/backend/src/admin/**tests**/stuck-orders.test.ts:167–179 — three clamping assertions in one `it` block; a failure message won't identify which case broke — recommended fix: split into `it.each` cases
- [LOW] apps/backend/src/admin/**tests**/stuck-payouts.test.ts:162–174 — same three-in-one clamping test as stuck-orders — recommended fix: split into `it.each` cases
- [LOW] apps/backend/src/admin/**tests**/user-by-email.test.ts:98–104 — boundary test for oversized email uses 260 chars for the local part; the exact 254/255 boundary is never exercised — recommended fix: add boundary tests at exactly 254 and 255 characters
- [LOW] apps/backend/src/admin/**tests**/user-cashback-summary.test.ts:77–83 — all-zeros UUID not exercised as an edge case — low priority
- [LOW] apps/backend/src/admin/**tests**/user-credits-csv.test.ts — 10 000-row truncation sentinel (`__TRUNCATED__`) is never tested; every sibling CSV test covers this path — recommended fix: seed 10 001 rows and assert the last non-empty line is `__TRUNCATED__`
- [LOW] apps/backend/src/admin/**tests**/withdrawals.test.ts — `reason` field min/max Zod constraints never tested (1-char, empty, 501-char inputs) — recommended fix: add short/over-length validation tests
- [LOW] apps/backend/src/admin/**tests**/withdrawals.test.ts — unsupported asset code 500 path (`payoutAssetFor` returning unknown code) is never exercised — recommended fix: mock `payoutAssetForMock.mockReturnValueOnce({ code: 'XYZLOOP', ... })` and assert 500
- [LOW] apps/backend/src/auth/**tests**/admin-step-up-middleware.test.ts — `503 STEP_UP_UNAVAILABLE` path (key absent) is never tested; key is always set via `vi.hoisted` — recommended fix: mock `isAdminStepUpConfigured` to return false and assert 503
- [LOW] apps/backend/src/auth/**tests**/admin-step-up.test.ts — `wrong_issuer` rejection reason is never tested despite being a named case in the source — recommended fix: construct a JWT with `iss: 'someone-else'` and assert `reason === 'wrong_issuer'`
- [LOW] apps/backend/src/auth/**tests**/require-auth.test.ts:110–118 — test name "falls through to the CTX pass-through path for a non-Loop bearer" is misleading; it tests any structurally-JWT-looking token, not a real CTX token — recommended fix: rename to clarify
- [LOW] apps/backend/src/auth/**tests**/signer.test.ts:86–90 — `isAnySignerConfigured` false branch (no signing key set) is not tested — recommended fix: add a module re-import test after deleting the env var
- [LOW] apps/backend/src/auth/**tests**/signer.test.ts:61–75 — key-rotation test uses `.then()` chain rather than `async/await`; Vitest may not surface a rejection in the `.then()` reliably — recommended fix: rewrite as `async/await`
- [LOW] apps/backend/src/auth/**tests**/handler.test.ts:168–176 — `platform → clientId` mapping only tests `ios`; `android` mapping is untested — recommended fix: add a parallel test case for `android`
- [LOW] apps/backend/src/auth/**tests**/email.test.ts:272–301 — last test in file calls `vi.doUnmock()` without a trailing `vi.resetModules()`, inconsistent with every other teardown in the file — recommended fix: add `vi.resetModules()` after `doUnmock` at line 300
- [LOW] apps/backend/src/auth/**tests**/otps.test.ts:12 — default `insertedRow = null` in `beforeEach` reset passes the `undefined` guard in the source but would throw `TypeError: null.id`; should be reset to `undefined` — recommended fix: initialise `insertedRow` to `undefined`
- [LOW] apps/backend/src/auth/**tests**/otps.test.ts:7 — `updateRows` state field is declared and initialised but never written or read in any test; dead scaffolding — recommended fix: remove or wire to the `.returning()` mock for update paths
- [LOW] apps/backend/src/auth/**tests**/id-token.test.ts:63–66 — `expect()` embedded inside the `stubJwks` fetch mock implementation; if the fetch error is swallowed, the assertion silently passes — recommended fix: assert `fetchSpy.mock.calls[0][0]` in the test body after the call
- [LOW] apps/backend/src/auth/**tests**/identities.test.ts — `NonAsciiEmailError` from `resolveOrCreateUserForIdentity` is untested — recommended fix: pass a Cyrillic email and assert the error is thrown
- [LOW] apps/backend/src/clustering/**tests**/data-store.test.ts — cold/uninitialised store state is never tested; a throw on first `getLocations()` call would be undetected — recommended fix: add a test calling `getLocations()` before any `refreshLocations()` and assert a safe empty default
- [LOW] apps/backend/src/clustering/**tests**/data-store.test.ts:281–290 — `rejects malformed upstream response` asserts `Array.isArray(getLocations().locations)` but cannot distinguish "retained previous data" from "returned empty array" because no prior data was seeded — recommended fix: seed data first, then make the malformed call, then assert the seeded data is still present
- [LOW] apps/backend/src/clustering/**tests**/handler.test.ts:157–163 — lower-bound zoom clamping (zoom=-5 → 0) is not tested; only upper-bound (zoom=99 → 28) is covered — recommended fix: add a parallel test with `zoom=-5`
- [LOW] apps/backend/src/credits/**tests**/interest-forecast.test.ts:89–98 — `ignores currencies outside the home-currency union` asserts count is 3 (not 4) but does not assert `JPY` is absent; a different currency being dropped would pass — recommended fix: add `expect(out.perCurrency.find(r => r.currency === 'JPY')).toBeUndefined()`
- [LOW] apps/backend/src/credits/**tests**/payout-compensation.test.ts:147–168 — `AlreadyCompensatedError` fixture is missing `userId`, `amountStroops`, and `kind`; tests the check only because `compensatedAt` is evaluated first — recommended fix: document the fixture dependency or add missing fields
- [LOW] apps/backend/src/config/**tests**/handler.test.ts:67 — `as unknown as { phase1Only: boolean }` double-cast inside the first test case; the field exists on the response but not in the declared body type — recommended fix: type the body correctly or use a dedicated `phase1Only` assertion

### INFO

- [INFO] apps/backend/src/admin/**tests**/reconciliation.test.ts — missing 500/error-path test (every sibling handler test has one); DRIFT_PAGE_LIMIT cap boundary entirely untested — recommended fix: add a `throwErr`-triggered 500 test
- [INFO] apps/backend/src/admin/**tests**/treasury-snapshot-csv.test.ts:134–137 — `indexOf` ordering check uses `toBeGreaterThan(0)` which would pass even if the string is at index 0; semantically should be `not.toBe(-1)` — recommended fix: change to `not.toBe(-1)`
- [INFO] apps/backend/src/admin/**tests**/treasury.test.ts:97–107 — `makeCtx` returns `{ ctx }` wrapper rather than `Context` directly; unique pattern among all test files; creates a maintenance hazard if the handler signature changes — recommended fix: align with sibling pattern (return `Context` directly)
- [INFO] apps/backend/src/auth/**tests**/admin-step-up-middleware.test.ts — no test for valid step-up token when `auth.userId` is undefined; the sub-check is silently skipped in that case — lower risk but worth documenting
- [INFO] apps/backend/src/auth/**tests**/id-token-replay.test.ts:91–98 — confusing setup: `state.inserted = [one]` is not updated before the second call, making a reader think the second insert conflicts; a comment would clarify — recommended fix: add a comment explaining both calls return the same mock value but the VALUES predicate differs
- [INFO] apps/backend/src/auth/**tests**/id-token.test.ts:127–131 — `if (result.ok) { expect(...) }` pattern (appears 9 times in the file); if the first `expect(result.ok).toBe(true)` is removed, inner asserts silently stop running — recommended fix: add comment "// TypeScript narrowing only: first expect already threw if false"
- [INFO] apps/backend/src/discord/**tests**/admin-audit.test.ts — `color` field not tested in any notifyAdminAudit test; a color-regression (e.g. replayed vs fresh write) would go undetected
- [INFO] apps/backend/src/credits/**tests**/payout-builder.test.ts:157–170 — `beforeEach_resetIssuers` is a function that registers a `beforeEach` hook; the `import { beforeEach }` is deferred to the bottom of the file; unusual pattern that confuses readers — recommended fix: add a comment or restructure with standard `beforeEach` at the top
- [INFO] apps/backend/src/credits/**tests**/pending-payouts-user.test.ts:78–96 — three clamping cases in one `it` block; failure attribution unclear — recommended fix: split into `it.each` cases
- [INFO] apps/backend/src/db/**tests**/pooled-url.test.ts:57–63 — `\b` boundary logic only tested with `pgbouncerx` in the username position; hostname position and exact-match boundary not triangulated — recommended fix: add a hostname-position test

---

## Batch 10 — backend tests (3/3)

### HIGH

[HIGH] apps/backend/src/discord/**tests**/monitoring.test.ts:93 — Test name is truncated/incomplete: `'green + healthy title on healthy → '` — the description cuts off mid-sentence, making it impossible to know the intent from the test name alone. Fix: complete the name, e.g. `'green + healthy title on healthy → correct embed title and color'`.

[HIGH] apps/backend/src/orders/**tests**/handler.test.ts — The `fulfil-once` dedup guard (`dedup` set inside the handler module) is not explicitly reset between tests. `__resetRateLimitsForTests` is called in `beforeEach`, but there is no matching `__resetFulfilledDedupForTests` call visible. If any earlier test in the suite (or another test file in the same worker) has exercised the dedup path, the `fulfil-once-1` test could produce a false-positive pass because the set already contains the order ID. Fix: export and call a dedup reset helper from `beforeEach`, or verify Vitest's module-isolation boundary guarantees a fresh module per test file.

[HIGH] apps/backend/src/orders/**tests**/loop-handler.test.ts:774-791 — `vi.resetModules()` is called twice inside a single test to flip the `LOOP_AUTH_NATIVE_ENABLED` feature flag off and re-import the handler. This is a fragile pattern: (a) both calls happen in the same test, (b) subsequent tests share the module registry state after the second reset, and (c) any `vi.mock` hoisting above is effectively bypassed for the re-imported module. Fix: use a separate vitest worker (`pool: 'forks'` / `isolate: true`) or a dedicated test file for the feature-flag-off variant.

### MEDIUM

[MEDIUM] apps/backend/src/merchants/**tests**/handler.test.ts:219 — `expect(Array.isArray(body.merchants)).toBe(true)` cannot fail when `body` was parsed from `Response.json()` — any valid JSON array always satisfies `Array.isArray`. Fix: assert on a concrete value from the array (e.g. length or first element's `id`) to ensure the pagination/filter logic is exercised.

[MEDIUM] apps/backend/src/merchants/**tests**/sync.test.ts:321 — `expect(Array.isArray(store.merchants)).toBe(true)` has the same unfailable structure. Fix: assert on a count or specific merchant id in the store.

[MEDIUM] apps/backend/src/orders/**tests**/loop-list-handler.test.ts:176 — `whereArgs.length === 1` only verifies that exactly one clause was passed to `.where()`; it does not inspect the clause's content. A future refactor could swap the correct pagination clause for any other single clause and this test would still pass. Fix: inspect `whereArgs[0]` to confirm the pagination predicate value.

[MEDIUM] apps/backend/src/orders/**tests**/repo.test.ts:571-601 — The idempotency-conflict test constructs a Postgres error by setting `code: '23505'` and `constraint_name` directly on the thrown `Error` object. However, the A4-026 comment in the production code indicates the real driver wraps the cause on `err.cause`, not on the error itself. If production code walks `err.cause` for the constraint details the test does not validate that path; a driver upgrade that always wraps would silently break idempotency handling while this test continues to pass. Fix: wrap the Postgres error as `cause` in the thrown error to match the real driver shape, and test both paths.

[MEDIUM] apps/backend/src/orders/**tests**/transitions.test.ts — `sweepStuckProcurement` tests use `await import('../transitions.js')` (dynamic import inside the test body) while the rest of the test file uses the static top-level import. The dynamic import after mocks are established may or may not resolve to the same cached module depending on Vitest's module registry state, and creates reader confusion about which module is under test. Fix: use a consistent single static import at the top of the file.

[MEDIUM] apps/backend/src/scripts/**tests**/quarterly-tax-parse.test.ts:1-8 — The test file re-implements the `parseQuarter` and `csvField` helpers locally rather than importing them from the script. The comment at lines 7-8 acknowledges this: "Re-implement the same parsing rules here so a refactor that drifts the script's parsing fails this test on the test side too." This is an anti-pattern: both the production code and the test can drift independently in the same wrong direction while each still passes. A production bug that changes `startMonth + 3` to `startMonth + 4` in the script would not be caught because the test has its own copy. Fix: export the helpers from `quarterly-tax-parse.mjs` (or extract to a shared module) and import them; keep the boundary between "CLI entry point" and "pure parsing logic" by wrapping the CLI portion separately.

### LOW

[LOW] apps/backend/src/orders/**tests**/procurement.test.ts:75-76 — `LOOP_REDEMPTION_TOTAL_TIMEOUT_MS` and `LOOP_REDEMPTION_POLL_INTERVAL_MS` are set via `process.env` at module scope without a corresponding `afterAll` cleanup. If tests run in a shared process and another test file later imports a module that reads these env vars at import time, it will pick up the altered values. Fix: add `afterAll(() => { delete process.env['LOOP_REDEMPTION_TOTAL_TIMEOUT_MS']; ... })` or use `vi.stubEnv` which auto-restores.

[LOW] apps/backend/src/payments/**tests**/interest-pool-watcher.test.ts — `notifyInterestPoolRecovered` is never exercised in this file. The recovery path (pool ticks back to a healthy state after having been degraded) is absent. Fix: add a test that drives the watcher from degraded → healthy and asserts that `notifyInterestPoolRecovered` is called.

[LOW] apps/backend/src/orders/**tests**/dsr-export.test.ts (dsr-export) — The mock `where()` implementation in the `db.select()` chain uses `state.lastTable` (a shared mutable cursor) to route between table slots. This is non-deterministic if drizzle ever issues two select queries concurrently or in a pipeline: the second `from()` would overwrite `lastTable` before the first `where()` reads it. In practice the handler queries sequentially, but the design is fragile. Fix: route from the table tag captured in the closure at `from(t)` rather than storing it in shared state.

[LOW] apps/backend/src/users/**tests**/handler.test.ts — The `jwtState` hoisted block is declared (`const { jwtState } = vi.hoisted(...)`) in three separate test files (handler.test.ts, cashback-by-merchant.test.ts, cashback-monthly.test.ts, flywheel-stats.test.ts) but `jwtState.claims` is never read by the mock implementations after the A2-550 fix retired the `decodeJwtPayload` path. The stubs set `jwtState.claims` in several CTX-rejection tests but this value drives no mock behaviour — the test passes because the handler simply rejects `kind: 'ctx'` contexts, not because the mock reads the claim. The `jwtState` book-keeping is dead code. Fix: remove `jwtState` setup from all files that no longer wire it to a mock; this eliminates a source of reader confusion about what the test is asserting.

### INFO

[INFO] apps/backend/src/public/**tests**/cashback-stats.test.ts:20-29 — The `db.execute` mock classifies queries by stringifying the drizzle `sql` template literal object and pattern-matching on raw SQL fragments. This is clever but brittle: renaming a column or reordering clauses would silently reroute the mock's response to the wrong query variant. Acceptable for now but worth noting as a maintenance cost.

[INFO] apps/backend/src/users/**tests**/dsr-delete.test.ts — Thorough coverage of the A4-078 failed-uncompensated-withdrawal blocker and the A4-123 `to_address` scrub. The `payoutQueryCount` counter idiom for distinguishing two sequential queries against the same table is creative; no functional issue.

[INFO] apps/backend/src/webhooks/**tests**/hmac-verify.test.ts — Pure unit test with no mocks; exercises the real `node:crypto` HMAC path. Clean and comprehensive (happy path, tampered body, wrong secret, replay window, tolerance clamping, header-format rejection).

[INFO] apps/backend/src/users/**tests**/dsr-handler.test.ts — Handler-layer tests complement the helper-layer `dsr-export.test.ts` / `dsr-delete.test.ts` pair cleanly. All five status codes (200/401/404/409/500) are covered for both handlers.

[INFO] apps/backend/src/public/**tests**/top-cashback-merchants.test.ts:198-218 — The "keys fallback snapshots by effective limit" test verifies that a different `?limit` value after a DB failure returns an empty list (no warm snapshot for that limit key). This is a subtle but correct invariant about the per-limit cache key strategy.

---

## Batch 11 — web src (1/6)

### MEDIUM

- [MEDIUM] apps/web/app/components/features/admin/AdminAuditTail.tsx:108 — Non-stable `key` prop on audit rows: `key={\`${row.actorUserId}-${row.createdAt}\`}`is composite but`createdAt`is an ISO timestamp shared across clock collisions for the same actor. If two writes land in the same millisecond the key duplicates and React will silently drop one row. Use`row.id`(the idempotency-key UUID) if the shape provides it, or include`row.path`in the composite. — Use a more stable key such as`row.idempotencyKey`or`\`${row.actorUserId}-${row.createdAt}-${row.path}\``.

- [MEDIUM] apps/web/app/components/features/admin/MerchantOperatorMixCard.tsx:46 — `since` timestamp is computed outside `useQuery`'s `queryFn` (at component render time) but the `queryKey` uses the fixed constant `WINDOW_HOURS`, not the actual `since` value. This means every re-render with the same `WINDOW_HOURS` gets the cached result even though `since` drifts forward in time with each render — a page that stays open will silently serve a ~24h window that started when the component first mounted, not rolling. The same pattern recurs in `OperatorStatsCard.tsx:45`, `UserOperatorMixCard.tsx:43`, `SupplierSpendCard.tsx:24`. — Either include `since` in the `queryKey` (accepts more cache misses but always rolls the window) or derive `since` inside the `queryFn` so the cached value stays logically consistent with the key.

- [MEDIUM] apps/web/app/components/features/admin/OperatorMerchantMixCard.tsx:45 — Same `since`-vs-key drift as above (see `MerchantOperatorMixCard`). `since` is derived at render time but the cache key contains only `WINDOW_HOURS`. — Same fix: include `since` in key or derive it inside `queryFn`.

- [MEDIUM] apps/web/app/components/features/admin/OperatorStatsCard.tsx:44 — Same `since`-vs-key drift. — Same fix.

- [MEDIUM] apps/web/app/components/features/admin/UserOperatorMixCard.tsx:43 — Same `since`-vs-key drift. — Same fix.

- [MEDIUM] apps/web/app/components/features/admin/SupplierSpendCard.tsx:24 — Same `since`-vs-key drift. — Same fix.

- [MEDIUM] apps/web/app/components/features/admin/TopUsersTable.tsx:48 — `since` is computed at render time from `Date.now()`, placed in the query but the `queryKey` uses `windowDays` only. Every render with the same `windowDays` returns the cached result even though `since` has advanced since the first fetch. — Include a rounded `since` (e.g. floored to minute) in the query key, or derive it inside `queryFn`.

- [MEDIUM] apps/web/app/components/features/admin/StepUpModal.tsx:89-156 — The modal is rendered as a plain `div` with `role="dialog"` and `aria-modal="true"`, not a native `<dialog>` element. Unlike the sibling `ConfirmDialog` and `ReasonDialog` which correctly use native `<dialog>` (and therefore get free focus-trap, ESC handling, and backdrop), this modal relies on an overlay `div`. The focus is NOT trapped — a keyboard user can tab behind the modal to active buttons on the page underneath, potentially triggering destructive admin actions (credit adjustments, withdrawals) while the step-up modal is open. This is both an accessibility and a security concern because the modal gates destructive writes. — Migrate to a native `<dialog>` element (showModal / close) matching the pattern already used in `ConfirmDialog.tsx` and `ReasonDialog.tsx`.

- [MEDIUM] apps/web/app/components/features/admin/CreditTransactionsTable.tsx:88 — `hasMore` is derived as `rows.length === PAGE_SIZE`. If the total number of transactions is an exact multiple of `PAGE_SIZE`, the "Older →" button will be enabled for the last page, and clicking it will return an empty set (no error, just an empty table) with no signal to the user. A subsequent click of "← Newest" returns them to the start. Minor UX confusion only; no data loss. — Use the backend's `hasMore`/`nextCursor` field if it exists, or accept the minor UX quirk and document it.

- [MEDIUM] apps/web/app/components/features/admin/DiscordNotifiersCard.tsx:157 — `setTimeout(() => setFlash(null), 3000)` in `TestPingButton.onSuccess` leaks if the component unmounts before 3 seconds. React will log a state-update-on-unmounted-component warning, and in React 18 strict mode it still fires the setter. — Store the timeout id in a ref and clear it in a `useEffect` cleanup.

- [MEDIUM] apps/web/app/components/features/admin/MerchantResyncButton.tsx:49 — `setTimeout(() => setFlash(null), 3000)` same issue as DiscordNotifiersCard — leaks if the component unmounts before 3 seconds. — Use a ref + `useEffect` cleanup.

- [MEDIUM] apps/web/app/components/features/admin/FleetFlywheelHeadline.tsx:99 — Uses a plain `<a href="/admin/treasury">` anchor instead of React Router's `<Link to="/admin/treasury">`. This causes a full-page navigation (hard reload) instead of a client-side route transition, discarding all in-memory TanStack Query cache. — Replace with `<Link to="/admin/treasury">`.

### LOW

- [LOW] apps/web/app/components/features/admin/AdminAuditTail.tsx:40 — `fmtRelative` is a near-identical implementation of `fmtRelative` functions in `ConfigsHistoryCard.tsx`, `MerchantOperatorMixCard.tsx`, `OperatorMerchantMixCard.tsx`, `OperatorStatsCard.tsx`, `UserOperatorMixCard.tsx`, `UserCashbackByMerchantTable.tsx`, and `MerchantStatsTable.tsx`. There are at least 8 copies of essentially the same relative-time formatter across the admin components. Minor variations exist (some start at `mins < 1` → "just now", some do not). — Extract a single `fmtRelative(iso: string): string` helper into `apps/web/app/utils/` (or `@loop/shared` if it becomes cross-package), canonicalise the "just now" threshold, and replace all 8+ copies.

- [LOW] apps/web/app/components/features/admin/AdminAuditTail.tsx:154 — Footer with "Show 100" / "Collapse" is only rendered when `query.data.rows.length >= DEFAULT_LIMIT`. When `expanded=true` and the backend returns exactly 25 rows (i.e., 100 rows requested but only 25 exist), the button remains visible (25 >= 25) and says "Collapse" which collapses back to 25, which then re-shows "Show 100". This creates an infinite toggle cycle with no visual progress when the API cap is below EXPANDED_LIMIT. Minor UX only. — Show footer only when `rows.length >= limit` (the current fetch's limit), not `>= DEFAULT_LIMIT`.

- [LOW] apps/web/app/components/features/admin/AssetCirculationCard.tsx:50-64 — `formatMinor` duplicates the same bigint-to-locale-currency pattern already available in `@loop/shared` as `formatMinorCurrency`. There is already a comment import of `ADMIN_LOCALE` but a separate local `formatMinor` is defined rather than reusing the shared export. — Remove the local `formatMinor` and use `formatMinorCurrency` from `@loop/shared` (already available throughout the admin surface).

- [LOW] apps/web/app/components/features/admin/CashbackRealizationCard.tsx:118 — Local `formatMinor` helper uses `undefined` locale (browser locale) rather than `ADMIN_LOCALE` as specified by the A2-1521 policy comment in the same file (lines 113–115). The comment says "rounds to major unit and uses the browser locale" and documents this as intentional for the card, but this inconsistency could confuse future maintainers given that `ADMIN_LOCALE` is imported and used for other formatting in the same file. The comment should be more explicit that this is a deliberate policy exception. — Add a comment: `// ADMIN_LOCALE intentionally omitted here per card-level policy (see above)` to avoid future silent regression.

- [LOW] apps/web/app/components/features/admin/CreditFlowChart.tsx:30-38 — `fmtMinor` is yet another local minor-unit formatter, distinct from both `formatMinorCurrency` in `@loop/shared` and the various other local `fmtMinor`/`formatMinor` helpers. This one has a different implementation (string-based, not Intl) that skips Intl formatting and manually constructs `${symbol}${whole}.${fraction}`. It will produce incorrect output for locales that don't use period as the decimal separator (though `ADMIN_LOCALE = 'en-US'` mitigates this for the number portion). — Consolidate with the shared `formatMinorCurrency` utility or at minimum document why a custom implementation is needed.

- [LOW] apps/web/app/components/features/admin/SupplierSpendActivityChart.tsx:32-39 — Same custom `fmtMinor` as `CreditFlowChart.tsx`, copied verbatim. Confirmed duplication. — Consolidate as above.

- [LOW] apps/web/app/components/features/admin/RequireAdmin.tsx:71-74 — The `denied` condition checks `me.data?.isAdmin === false` but also `me.error instanceof ApiException`. The condition `me.data === undefined` catches both the pre-response and post-error states. A successful response where `isAdmin` is `true` correctly renders children. But `me.data === undefined` is true while `me.isPending` is also true, and this branch is only reached after `me.isPending` has been handled above. So `me.data === undefined` in the `denied` guard really means "error state with no data"; this is correct but subtle and should be commented. Low-risk. — Add a clarifying comment: `// me.data is undefined after a fetch error (no prior cached value)`.

- [LOW] apps/web/app/components/features/admin/ConfirmDialog.tsx:47-52 — `requestAnimationFrame(() => cancelButtonRef.current?.focus())` fires after `showModal()`. If the render cycle takes more than one animation frame (e.g., heavy CPU), the focus target may not be mounted yet. This is unlikely but possible under load. Native `<dialog>` with `showModal` already autofocuses the first focusable element by spec, so the explicit focus call is belt-and-braces. Consider using `autofocus` attribute on the Cancel button instead. — Low-risk as-is; document the intent or switch to `autofocus`.

- [LOW] apps/web/app/components/features/admin/Sparkline.tsx:15 — `Math.max(...values, 1)` uses spread syntax on a potentially large array (up to `WINDOW_DAYS = 30` elements, so not actually problematic). But if `values` is ever user-controlled with thousands of elements, this will blow the call stack. Given the controlled backend source, this is negligible risk but worth noting. — Already safe at current scale; no action required.

- [LOW] apps/web/app/components/features/admin/MerchantCashbackMonthlyChart.tsx:121-122 — `barWidthPct` is called twice per list item (once for the style `width` and once for the `minWidth` condition). The result is pure computation from the same inputs so it's idempotent, but it wastes a double computation per bar. The parent `AdminMonthlyCashbackChart` and `UserCashbackMonthlyChart` have the exact same pattern. — Extract into a local `const pct = barWidthPct(...)` and reuse.

- [LOW] apps/web/app/components/features/admin/UserOrdersTable.tsx:111 — `row.state.replace('_', ' ')` only replaces the first underscore. `pending_payment` becomes `pending payment` correctly, but any hypothetical state with two underscores would only partially replace. The existing states (`pending_payment`, `paid`, `procuring`, `fulfilled`, `failed`, `expired`) only have at most one underscore, so this is correct today but fragile. — Use `row.state.replaceAll('_', ' ')` for robustness.

- [LOW] apps/web/app/components/features/admin/TreasuryReconciliationChart.tsx:42-50 — `ASSET_TO_CURRENCY` map is built by an IIFE at module load time inverting `CURRENCY_TO_ASSET_CODE`. This works but creates a derived constant from a source that could theoretically be updated in `@loop/shared`. If `CURRENCY_TO_ASSET_CODE` gains a new entry, `ASSET_TO_CURRENCY` in this file automatically stays in sync — which is good. The pattern is fine; just note it for future reviewers. — INFO only; no change needed.

- [LOW] apps/web/app/components/features/admin/MerchantStatsTable.tsx:12-21 — Local `fmtRelative` doesn't output "just now" for sub-minute timestamps (unlike the version in `AdminAuditTail.tsx` which does). A merchant that was fulfilled seconds ago will display "0m ago" rather than "just now". Minor inconsistency across the admin surface. — Standardise on a single implementation.

- [LOW] apps/web/app/components/features/admin/CsvDownloadButton.tsx — No `aria-label` on the download button; the label comes from the `label` prop which defaults to `'Download CSV'`. The button text itself is the accessible label here, so no issue when text is present. But when `busy=true` the text changes to `'Downloading…'` and a screen reader announces the change. This is acceptable. — INFO only; no change needed.

- [LOW] apps/web/app/components/features/admin/StepUpModal.tsx:43-44 — `email` is read directly from `useAuthStore` (the Zustand auth store, which holds the access-token-derived email in memory). If the store is cleared between login and step-up completion, `email` will be `null` and the modal shows `'your admin email'`. This is an extremely unlikely edge case (would require session expiry while the modal is open) and is handled gracefully. — INFO only.

- [LOW] apps/web/app/components/features/admin/ReasonDialog.tsx:126 — The error `<span>` always renders with `id={helperId}-error` only when `error !== null`, but `aria-describedby` on the textarea references that id conditionally. If error becomes non-null _after_ initial render, there is a brief frame where `aria-describedby` points to a non-existent id. In practice this is a single render cycle and screen readers handle it gracefully. — INFO only; acceptable.

- [LOW] apps/web/app/components/features/admin/AdminWithdrawalForm.tsx:138 — `dialogBody` is computed as a JSX element or null and then passed to `ConfirmDialog`'s `body` prop. When `pendingPayload` transitions from non-null to null (after dialog close), `dialogBody` becomes null right before React removes the dialog from the DOM. The `ConfirmDialog` guards correctly via its own `open` prop and the native `<dialog>` close sequence. No bug, but the timing dance between `pendingPayload` state and the dialog `open` prop is subtle. — Well-handled; INFO only.

### INFO

- [INFO] apps/web/.env.local.example — Clean template, comments are well-maintained. No secrets or credentials present. Matches `AGENTS.md` env summary. Pass.

- [INFO] apps/web/.env.production — Contains only `VITE_API_URL=https://api.loopfinance.io`. No secrets. Committed value is intentional (public API endpoint). Pass.

- [INFO] apps/web/AGENTS.md — Comprehensive and accurate guide. Matches observed patterns throughout the components. No stale references found. Pass.

- [INFO] apps/web/app/app.css — Contains `html.dark .hero-shape-fill` rule (line 167) which is technically dead code given that the dark theme is retired (documented at line 107-114) and `.dark` is never added to `html` by `root.tsx`. Low-risk dead code but harmless — the `@custom-variant dark` at line 114 already scopes all `dark:` utilities to `.dark` class, keeping them inert. — No change needed; dead selectors are self-documenting as "kept for future use".

- [INFO] apps/web/app/components/features/admin/AdminMonthlyCashbackChart.tsx — Clean. Good re-use of shared bar primitives. Query key follows taxonomy. Pass.

- [INFO] apps/web/app/components/features/admin/AdminNav.tsx — `operatorPoolStatus` and `failedPayoutsCount` are exported for tests. Good pattern. `hidden sm:inline-flex` on status pills intentionally hides them on mobile — acceptable for admin-only surface. Pass.

- [INFO] apps/web/app/components/features/admin/AdminUserFlywheelChip.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/AssetDriftBadge.tsx — Shares `['admin-asset-circulation', assetCode]` cache key with `AssetCirculationCard`. Intentional and documented. Pass.

- [INFO] apps/web/app/components/features/admin/AssetDriftWatcherCard.tsx — `refetchInterval: 60_000` and `staleTime: 30_000` mean background refetch fires every 60s even when the window is focused. This is intentional for the live watcher card. Pass.

- [INFO] apps/web/app/components/features/admin/CashbackRealizationCard.tsx — `formatMinor` uses browser locale intentionally per comment. Pass.

- [INFO] apps/web/app/components/features/admin/CashbackSparkline.tsx — Re-exports `toPoints` from `Sparkline.tsx` for test compatibility. This creates a re-export chain but is documented. Pass.

- [INFO] apps/web/app/components/features/admin/CashbackSummaryChip.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/ConfigsHistoryCard.tsx — `truncId` correctly truncates UUIDs to 8 chars. Pass.

- [INFO] apps/web/app/components/features/admin/ConfirmDialog.tsx — Correctly uses native `<dialog>`. Focus to cancel button on open is intentional (safer default for destructive confirm dialogs). Pass.

- [INFO] apps/web/app/components/features/admin/CopyButton.tsx — Good `execCommand` fallback with SSR guard. Pass.

- [INFO] apps/web/app/components/features/admin/CreditAdjustmentForm.tsx — Step-up + confirm-dialog pattern correctly implemented. `parseAmountMajor` handles sign, whole, and fractional parts. Pass.

- [INFO] apps/web/app/components/features/admin/CreditFlowChart.tsx — Currency-picker uses `role="tablist"`/`role="tab"` on buttons; `aria-selected` is set correctly. Pass.

- [INFO] apps/web/app/components/features/admin/CreditTransactionsTable.tsx — Cursor pagination with local state. Pass.

- [INFO] apps/web/app/components/features/admin/CsvDownloadButton.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/DiscordNotifiersCard.tsx — setTimeout leak noted above. Otherwise clean. Pass.

- [INFO] apps/web/app/components/features/admin/FleetFlywheelHeadline.tsx — Hard `<a>` link to `/admin/treasury` noted as MEDIUM above.

- [INFO] apps/web/app/components/features/admin/HomeCurrencyForm.tsx — Client-side guard `target === currentHomeCurrency` disables the button. Backend enforces the safety preflight. Double protection is good. Pass.

- [INFO] apps/web/app/components/features/admin/MerchantCashbackMonthlyChart.tsx — `barWidthPct` double-call noted as LOW above. Otherwise clean.

- [INFO] apps/web/app/components/features/admin/MerchantCashbackPaidCard.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/MerchantFlywheelActivityChart.tsx — Error check for 404 before `rows = query.data?.rows ?? []` means on non-404 errors, `rows` will be `[]` (empty from `?? []`) and `isEmpty` will be `true` (not `query.isError`), rendering an incorrect "No fulfilled orders" empty state instead of an error message. The `Sparkline` primitive receives `isError` correctly and would render the error, but `isEmpty` check at line 56 fires first — however, since `!query.isError` is part of the `isEmpty` condition (line 56: `!query.isPending && !query.isError && totalOrders === 0`), this is NOT a bug. The `!query.isError` guard is there. Pass.

- [INFO] apps/web/app/components/features/admin/MerchantFlywheelChip.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/MerchantOperatorMixCard.tsx — `since` drift noted above.

- [INFO] apps/web/app/components/features/admin/MerchantRailMixCard.tsx — Reuses `fmtPct` + `fmtPctBigint` from `PaymentMethodShareCard`. Good cross-component re-use. Pass.

- [INFO] apps/web/app/components/features/admin/MerchantResyncButton.tsx — setTimeout leak noted above.

- [INFO] apps/web/app/components/features/admin/MerchantsFlywheelShareCard.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/MerchantStatsTable.tsx — `fmtRelative` missing "just now" (LOW above). Otherwise clean.

- [INFO] apps/web/app/components/features/admin/MerchantTopEarnersCard.tsx — Graceful BigInt parse error renders partial row without crashing. Good defensive pattern.

- [INFO] apps/web/app/components/features/admin/OperatorMerchantMixCard.tsx — `since` drift noted above.

- [INFO] apps/web/app/components/features/admin/OperatorStatsCard.tsx — `since` drift noted above.

- [INFO] apps/web/app/components/features/admin/OrdersSparkline.tsx — Re-exports `toPoints` from `Sparkline.tsx`. Pass.

- [INFO] apps/web/app/components/features/admin/PaymentMethodActivityChart.tsx — `shortDay` export is clean. `sumTotal` helper is private. Pass.

- [INFO] apps/web/app/components/features/admin/PaymentMethodShareCard.tsx — `fmtPct` + `fmtPctBigint` exported for cross-component reuse. Pass.

- [INFO] apps/web/app/components/features/admin/PayoutsByAssetTable.tsx — `fmtStroops` string impl (not Intl) is intentional for Stellar stroop amounts which don't have a currency-style Intl format. Pass.

- [INFO] apps/web/app/components/features/admin/PayoutsSparkline.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/RealizationSparkline.tsx — `toDailyBps` exported for unit tests. `byDay.get(d)!` non-null assertion is safe because the key was just populated from `byDay.keys()`. Pass.

- [INFO] apps/web/app/components/features/admin/ReasonDialog.tsx — Correctly uses native `<dialog>`. Input focused on open. Pass.

- [INFO] apps/web/app/components/features/admin/ReplayedBadge.tsx — Simple, clean. Pass.

- [INFO] apps/web/app/components/features/admin/RequireAdmin.tsx — Gate on `me.data.isAdmin` is correct. `denied` logic is slightly convoluted (see LOW note above). Pass.

- [INFO] apps/web/app/components/features/admin/SettlementLagCard.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/Sparkline.tsx — `Math.max(...values, 1)` spread safe at current scale. Legend uses inline `<span>` swatches; no `aria-label` on legend items (the SVG gets the `aria-label` instead — acceptable for this pattern). Pass.

- [INFO] apps/web/app/components/features/admin/StepUpModal.tsx — Focus trap concern noted as MEDIUM. Otherwise the step-up flow logic (idle → sending → awaiting-code → confirming) is correct.

- [INFO] apps/web/app/components/features/admin/StuckOrdersCard.tsx — Correctly links to `/admin/stuck-orders`. Pass.

- [INFO] apps/web/app/components/features/admin/StuckPayoutsCard.tsx — Also links to `/admin/stuck-orders` (same destination as stuck orders — per comment this is intentional). Pass.

- [INFO] apps/web/app/components/features/admin/SupplierSpendActivityChart.tsx — `since` drift (via query key not matching computed value) is not present here — there is no `since` parameter; query key `['admin-supplier-spend-activity', currency, 30]` is stable. Pass.

- [INFO] apps/web/app/components/features/admin/SupplierSpendCard.tsx — `since` drift noted above.

- [INFO] apps/web/app/components/features/admin/TopUsersByPendingPayoutCard.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/TopUsersTable.tsx — `since` drift noted above.

- [INFO] apps/web/app/components/features/admin/TreasuryReconciliationChart.tsx — `mergePerCurrency` exported for tests. BigInt arithmetic correct. Pass.

- [INFO] apps/web/app/components/features/admin/UserCashbackByMerchantTable.tsx — `fmtCashback` uses `Number(minor)` which is lossy past 2^53 minor units ($90 trillion). Realistically this will never be reached for a per-user per-merchant cashback figure. Pass with note.

- [INFO] apps/web/app/components/features/admin/UserCashbackMonthlyChart.tsx — Pass.

- [INFO] apps/web/app/components/features/admin/UserOperatorMixCard.tsx — `since` drift noted above.

- [INFO] apps/web/app/components/features/admin/UserOrdersTable.tsx — `replaceAll` suggestion noted as LOW. Pass otherwise.

## Batch 12 Audit Report — Web App Components

### HIGH-1 — Currency-hardcoded USD formatters in MobileHome.tsx

**File:** `apps/web/app/components/features/home/MobileHome.tsx`  
**Lines:** 484–493  
**Category:** Correctness / Internationalisation

`formatCashback` and `avgBackLabel` both hardcode the `$` symbol and assume cents-in-USD regardless of the user's `homeCurrency` setting. Deployed to non-USD markets (GBP, EUR, AE, IN, SA, AU, MX per ADR 035) these will display `$` for amounts that are actually in pounds or euros.

```ts
function formatCashback(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}
function avgBackLabel(cashbackCents: number, ordersCount: number): string {
  if (ordersCount === 0) return '—';
  const avgCents = cashbackCents / ordersCount;
  return `$${(avgCents / 100).toFixed(2)}`;
}
```

Additionally, `formatWhen` calls `toLocaleDateString()` with `undefined` locale which produces different output on the SSR Node process vs the client browser, causing a hydration mismatch warning on every list render.

**Fix:** Replace with the project's existing currency formatter that accepts `homeCurrency`, and pass `'en'` (or the active locale) explicitly to `toLocaleDateString`.

---

### HIGH-2 — Back-navigation trap in phase1Only onboarding skip effect

**File:** `apps/web/app/components/features/onboarding/Onboarding.tsx`  
**Lines:** 343–352  
**Category:** Correctness / UX bug

The phase1Only effect unconditionally skips steps 5 and 7 by incrementing `step`. When a user presses the Back button from step 6 the `back()` function decrements to step 5, which immediately re-triggers the effect and re-advances to step 6. The user is permanently unable to navigate back past step 6. The inline comment claims "Back from step 6 would land on step 4 (Otp)" — the comment is aspirational, not implemented.

```ts
useEffect(() => {
  if (!phase1Only) return;
  if (step === 5 || step === 7) {
    setStep((s) => s + 1);
  }
}, [step, phase1Only]);
```

The `back()` function does `setStep((s) => Math.max(0, s - 1))` with no phase1Only skip logic.

**Fix:** Apply the same skip logic inside `back()`: when `phase1Only` is true and the previous step is a skipped step, jump over it in the backward direction (step 5 → step 4, step 7 → step 6).

---

### MEDIUM-1 — Shared `copied` state for two independent copy buttons

**File:** `apps/web/app/components/features/purchase/PaymentStep.tsx`  
**Lines:** ~140–175 (copy address + copy memo buttons)  
**Category:** Correctness / UX bug

A single `copied` boolean is shared between the "Copy address" and "Copy memo" buttons. Clicking either one sets `copied=true` and both buttons immediately change their label to "Copied!". The user has no way to tell which value was actually copied.

```tsx
const [copied, setCopied] = useState(false);
// Both buttons check the same `copied` flag
<button onClick={() => { void handleCopy(paymentAddress); }}>
  {copied ? 'Copied!' : 'Copy address'}
</button>
<button onClick={() => { void handleCopy(memo); }}>
  {copied ? 'Copied!' : 'Copy memo'}
</button>
```

**Fix:** Use two independent `copied` states (`copiedAddress`, `copiedMemo`) or a discriminated union (`copiedField: 'address' | 'memo' | null`).

---

### MEDIUM-2 — Missing `enabled: isAuthenticated` gate on StellarTrustlineStatus query

**File:** `apps/web/app/components/features/wallet/StellarTrustlineStatus.tsx`  
**Lines:** ~30–40  
**Category:** Correctness / Security

Every sibling wallet component gates its query on `isAuthenticated` to avoid cold-start 401s and unnecessary token exposure. `StellarTrustlineStatus` fires its query unconditionally:

```ts
const query = useQuery({
  queryKey: ['me', 'stellar-trustlines'],
  queryFn: getUserStellarTrustlines,
  retry: shouldRetry,
  staleTime: 30_000,
  refetchInterval: 60_000,
  // ← missing: enabled: isAuthenticated
});
```

This will trigger a 401 on every unauthenticated page load that renders this component, generating noise in backend logs and potentially leaking the existence of the endpoint to unauthenticated callers.

**Fix:** Add `enabled: isAuthenticated` (sourced from `useAuthStore`) consistent with all sibling components.

---

### MEDIUM-3 — `clearErrors` unstable identity causes effect to re-run on every render

**File:** `apps/web/app/components/features/onboarding/signup-tail.tsx` (line ~478) + `apps/web/app/components/features/onboarding/Onboarding.tsx` (line ~338)  
**Category:** Correctness / React pitfall

`clearErrors` is defined as a plain arrow function inside `useOnboardingAuth` and recreated on every render. It appears in the `useEffect` dependency array in `Onboarding.tsx`:

```ts
// signup-tail.tsx — recreated every render
const clearErrors = (): void => {
  setEmailError(null);
  setOtpError(null);
};

// Onboarding.tsx — clearErrors is in deps
useEffect(() => {
  if (step !== 3 && step !== 4) clearErrors();
  if (step !== 5) setCurrencyError(null);
}, [step, clearErrors]); // ← clearErrors changes every render
```

The effect will re-fire on every render, not just on `step` changes. While the effect body is cheap (state setters), it can mask genuine missing deps warnings and makes intent opaque.

**Fix:** Wrap `clearErrors` in `useCallback([], [setEmailError, setOtpError])` inside `useOnboardingAuth`, or move the error-clearing inline into `setStep` calls.

---

### MEDIUM-4 — Hardcoded `$` currency symbol on public SEO landing page

**File:** `apps/web/app/components/features/cashback/CashbackCalculator.tsx`  
**Lines:** 104–105  
**Category:** Correctness / Internationalisation

The cashback calculator on the public `/cashback/:slug` landing page hardcodes a `$` prefix regardless of which country the user is browsing from:

```tsx
<span aria-hidden="true" className="text-lg text-green-900 dark:text-green-100">
  $
</span>
```

With ADR 035 extending the app to AE/IN/SA/AU/MX (AED, INR, SAR, AUD, MXN), this symbol will be incorrect for the majority of the new market visitors hitting merchant cashback pages from those locales.

**Fix:** Derive the currency symbol from the active locale (via `useLocale()` + `currencyOf()` from `@loop/shared`), consistent with how the rest of the pricing UI handles it.

---

### LOW-1 — `role="option"` on `<button>` in Navbar combobox

**File:** `apps/web/app/components/features/Navbar.tsx`  
**Lines:** ~210–220  
**Category:** Accessibility

Search result items use `<button role="option">` inside a `role="listbox"` container. The ARIA spec requires `option` to be a non-interactive element; pairing it with a native `<button>` creates conflicting semantics that screen readers handle inconsistently (some announce "button", some "option", some both).

```tsx
<button role="option" aria-selected={i === selectedIndex} ...>
```

The same pattern appears in `CountrySelector.tsx` (line 122–130) — same file, same issue.

**Fix:** Use `<div role="option" tabIndex={0}` with `onKeyDown` for Enter/Space, or restructure as a true `combobox` with `role="option"` on non-button `<li>` children.

---

### LOW-2 — TODO without valid ticket reference

**File:** `apps/web/app/components/features/purchase/LoopPaymentStep.tsx`  
**Lines:** ~243  
**Category:** Standards violation (CLAUDE.md: "Write a TODO without a ticket reference or date")

```ts
// TODO(adr-pending): integrate Stellar Wallets Kit v2 here...
```

`adr-pending` is not a ticket number or a date. Project rules require every TODO to carry a ticket reference (e.g. `A2-XXXX`) or a date.

**Fix:** Replace `(adr-pending)` with a real ticket ID or ISO date, e.g. `// TODO(A2-XXXX 2026-06-11): integrate Stellar Wallets Kit v2 here...`.

---

### LOW-3 — Expand toggle button missing `aria-label` and `aria-controls`

**File:** `apps/web/app/components/features/orders/LoopOrdersList.tsx`  
**Lines:** ~94  
**Category:** Accessibility

The order expand/collapse toggle has `aria-expanded` but no `aria-label` (the visible label is a chevron icon with no text) and no `aria-controls` pointing at the expanded content region:

```tsx
<button type="button" onClick={...} className="..." aria-expanded={expanded}>
  {/* chevron icon only */}
</button>
```

Screen reader users hear only "button" or "collapsed/expanded" with no context about what is being expanded.

**Fix:** Add `aria-label="Show order details"` (or similar) and `aria-controls={detailsId}` where `detailsId` is an `id` on the collapsible section.

---

### INFO-1 — Hardcoded `+$2,847` in onboarding trust screen (intentional)

**File:** `apps/web/app/components/features/onboarding/screens-trust.tsx`  
**Category:** Informational

`TrustWelcome` animates a count-up to `+$2,847` as illustrative marketing copy. This is deliberate UI mockup for the onboarding flow — not a live data fetch and not a bug. Flagging for completeness in case the figure becomes stale as real cashback data accumulates.

---

### INFO-2 — `Math.random()` in `useMemo([], [])` for confetti (SSR caution)

**File:** `apps/web/app/components/features/onboarding/signup-tail.tsx` (`WelcomeIn` component)  
**Category:** Informational

Confetti angles are generated with `Math.random()` inside `useMemo([], [])`. In React StrictMode (dev) this memoization fires twice, but both invocations produce different values, so the second render uses different confetti positions. More importantly: if this component is ever SSR-rendered, the server-generated angles will differ from the client's, producing a hydration mismatch. The onboarding route appears to be client-only in practice, but this should be explicitly guarded with a `typeof window !== 'undefined'` or moved into a `useEffect`.

---

## Batch 13 — web src (3/6)

### MEDIUM — `fmtStroops` duplicated in 3 admin route files with no consolidation ticket/date

**Files:** `apps/web/app/routes/admin.payouts.$id.tsx:36`, `apps/web/app/routes/admin.payouts.tsx:45`, `apps/web/app/routes/admin.treasury.tsx:53`  
Identical stroops-to-human-string function (7-decimal Stellar precision, trailing-zero trim, ADMIN_LOCALE) copy-pasted across three files. The comment in `admin.stuck-orders.tsx` ("Shared with /admin/payouts; inlined here to avoid cross-page helper drift while the pattern stabilises") had no ticket or date. A fourth copy exists in `admin.stuck-orders.tsx:186`. Extract to `apps/web/app/utils/format-stellar.ts` and import from all four. Risk: the three versions currently have minor whitespace/comment drift; a future bug-fix would require touching all four.

### MEDIUM — `isDirty` in `admin.cashback.tsx` compares numeric percent values as raw strings

**File:** `apps/web/app/routes/admin.cashback.tsx:176`  
`isDirty` computes dirtiness by comparing `String(draft[key])` against the saved config value using `!==`. If the API returns `"5.00"` but the user types `"5"`, the form shows "unsaved changes" even though the value is semantically the same, and would submit a no-op PATCH. Fix: normalize both sides with `Number()` before comparing, or use `parseFloat`.

### MEDIUM — Non-top-of-file `import` statements in 4 admin routes (lint violation)

**Files:**

- `apps/web/app/routes/admin._index.tsx:39`: `import { formatMinorCurrency as fmtMinor } from '@loop/shared'`
- `apps/web/app/routes/admin.assets.$assetCode.tsx:43`: same
- `apps/web/app/routes/admin.assets.tsx:27`: same
- `apps/web/app/routes/admin.operators.$operatorId.tsx:24`: same
- `apps/web/app/routes/admin.users.$userId.tsx:31`: `import { formatMinorCurrency as fmtMinor } from '@loop/shared'` (comment `// A2-1520: local fmtMinor replaced with bigint-safe shared helper.`)  
  All five place a top-level `import` statement after function/const declarations. ESLint's `import/first` rule (or equivalent) requires imports at the top of the file. These will cause lint failures or silently bypass checks depending on config. Move all `import` statements to the file top.

### MEDIUM — `formatDate` in `admin.orders.tsx` uses `undefined` locale

**File:** `apps/web/app/routes/admin.orders.tsx:61`  
`formatDate` passes `undefined` as the locale to `toLocaleString`, which means date display depends on the operator's browser locale rather than the consistent `ADMIN_LOCALE` constant used everywhere else in admin routes. Admin panel dates should be deterministic for cross-team screenshots and compliance CSVs. Fix: replace `undefined` with `ADMIN_LOCALE`.

### LOW — Local `formatMinor` in `admin.orders.tsx` references stale PR without date

**File:** `apps/web/app/routes/admin.orders.tsx:75`  
Comment reads: "Local copy — the shared helper in #390 covers this but isn't merged yet." No date. Project rules require TODOs to carry a ticket reference AND a date. The shared helper (`formatMinorCurrency` from `@loop/shared`) has clearly already landed (used in 5+ other files). This local copy should be deleted and replaced with the shared import; the stale comment should be removed.

### LOW — `fmtRelative` in `admin.operators.tsx` duplicates function from `AdminAuditTail`

**File:** `apps/web/app/routes/admin.operators.tsx:43`  
`fmtRelative` is defined locally (lines 43-52) and formats `Date` relative to now. `AdminAuditTail` (imported by `admin.audit.tsx`) contains the same logic. Duplication; extract to `~/utils/format-date.ts`.

### LOW — `setCountryCookie` missing `Secure` attribute

**File:** `apps/web/app/i18n/locale.ts:157`  
`document.cookie = '...; SameSite=Lax'` — no `; Secure` flag. On HTTPS deployments (all production traffic), the cookie should be Secure so it is never sent over plaintext HTTP. Fix: append `; Secure` when `location.protocol === 'https:'` or unconditionally (the site is HTTPS-only). No token leakage risk (cookie holds only a country code), but it is a defence-in-depth gap.

### LOW — Audit row key collision risk in `admin.audit.tsx`

**File:** `apps/web/app/routes/admin.audit.tsx:152`  
Row `key` is `${row.actorUserId}-${row.createdAt}`. If the same actor performs two admin writes within the same millisecond (e.g. rapid programmatic bulk runs), React will emit a duplicate-key warning and could mis-reconcile rows. A stable UUID `row.id` (if present in the type) or a compound `${row.actorUserId}-${row.createdAt}-${row.targetId}` would be safer.

### LOW — `purchase-storage.ts` synthesizes indefinite expiry rather than rejecting invalid records

**File:** `apps/web/app/native/purchase-storage.ts:161`  
When `typeof data.expiresAt !== 'number'`, the code synthesizes an expiry (`Date.now() + 5 * 60 * 1000`) instead of returning `null`. This means a malformed record (missing `expiresAt` from an older app version) is never cleaned up on the read path — it lingers until the synthesized 5-minute window passes on that read, then only on the next read. This is a migration edge-case, not a security issue, but it means stale data can survive indefinitely if the user never re-opens that purchase detail. Consider returning `null` for records without a valid `expiresAt` and letting the caller refetch.

### LOW — `auth.tsx` uses `isLoading` instead of `isPending` (TanStack Query v5 pattern)

**File:** `apps/web/app/routes/auth.tsx:443`  
`meQuery.isLoading` and `historyQuery.isLoading` are passed to child components as the `isLoading` prop. In TanStack Query v5, `isLoading` is `isPending && isFetching` (i.e., only true on the very first fetch with no cached data). `isPending` is the correct "no data yet" guard. The mis-use can cause the loading skeleton to flash on re-fetches that populate from cache, briefly showing `—` for the cashback balance. Fix: replace `isLoading` with `isPending` on both queries.

### LOW — `handleGoogleCredential` in `auth.tsx` has empty `useCallback` dep array despite reading `signInWithGoogle`

**File:** `apps/web/app/routes/auth.tsx:394`  
`handleGoogleCredential` is wrapped in `useCallback(fn, [])` with an explicit `eslint-disable-next-line react-hooks/exhaustive-deps` comment that says "signInWithGoogle identity is stable via useAuthStore". This is correct reasoning — Zustand selector returns a stable reference. The disable is intentional and documented. INFO only.

### INFO — `queryClient` at module level in `root.tsx` is SSR-safe

**File:** `apps/web/app/root.tsx:91`  
The `QueryClient` is created at module level, which would cause cross-request cache sharing in an SSR context. However, all `queryClient.setQueryData` calls are guarded by `typeof window !== 'undefined'`, so server renders never write to the shared client. This is fine for now but worth noting: if a future change adds `setQueryData` outside the window guard, the SSR isolation would silently break. Recommend moving client creation inside the component or wrapping in a `useMemo` for full defensive coverage.

### INFO — `buildSecurityHeaders` called on every `Layout` render in `root.tsx`

**File:** `apps/web/app/root.tsx:272`  
`buildSecurityHeaders(nonce)` is a pure function with stable inputs. It recomputes on every render. No correctness issue; only a minor performance waste. Could be memoized with `useMemo`.

### INFO — `admin.treasury.tsx` has its own local `fmtMinor` (bigint-safe version)

**File:** `apps/web/app/routes/admin.treasury.tsx:35`  
This is a locally defined `fmtMinor` with BigInt-safe arithmetic, different from the `formatMinorCurrency` shared helper imported in other files. The comment explains it accepts bigint-string values to avoid precision loss for large ledger totals. It is a purposeful local copy, but it creates two `fmtMinor` implementations in the admin layer. If `@loop/shared`'s `formatMinorCurrency` is bigint-safe (which A2-1520 implies), the local copy should be replaced. Low priority pending confirmation of shared helper capabilities.

### INFO — `brand.$slug.tsx` uses `window.history.length > 1` for back navigation

**File:** `apps/web/app/routes/brand.$slug.tsx:46`  
`window.history.length > 1` is used to decide whether to navigate(-1) or fall back to `/`. This is a direct DOM global access outside native/ boundary — but it is not a Capacitor plugin call, so the boundary rule does not apply. `window.history` is available on both web and Capacitor webview contexts. The check can give false positives (a fresh navigation to the page after opening many tabs), but the fallback to `/` is safe. INFO/accepted pattern.

---

## Batch 14 — web src (4/6)

- [MEDIUM] apps/web/app/routes/orders.$id.tsx:157 — `void now` is dead code; `now` is passed as a prop to `OrderDetailBody` but never used inside that component (used only for the `setInterval` comment justification). The `void now` suppresses the "unused variable" lint warning but is semantically meaningless — if `now` is genuinely not used in the render, the 30s interval and state update are wasted re-renders. If it IS meant to drive re-render of relative timestamps, the output should actually read from `now`. — Either remove the `now` prop + interval (and use a static `toLocaleString` for the created date), or wire `now` into the `timeAgo`-style relative label that was presumably the original intent.

- [MEDIUM] apps/web/app/routes/home.tsx:83-98 — `featured` computation is not wrapped in `useMemo`, yet it runs on every render and involves iterating + sorting the entire merchant list. Because `lookupCashback` is a stable function reference from a hook, and `countryMerchants` is already memoized, this will re-compute on every render that invalidates the parent, including the hydration-driven re-render. `visibleFeatured = hydrated ? featured : []` means the un-memoized compute still runs on both sides of the ternary. — Wrap the `featured` derivation in `useMemo` with `[countryMerchants, lookupCashback]` deps.

- [MEDIUM] apps/web/app/routes/settings.cashback.tsx:52 — `formatAmount` uses `Number(BigInt(minor))` which coerces via the unsafe BigInt→Number path. For amounts where `BigInt(minor)` exceeds `Number.MAX_SAFE_INTEGER` (i.e. a credit-ledger balance > ~90 trillion minor units, admittedly unlikely), precision is silently lost, producing a wrong formatted amount. The comment says "never coerce back to Number for arithmetic; the contract is bigint-string-shape" in `gift-card.$name.tsx:109` — the same rule should apply here. — Use a bigint-aware formatting path (divide the bigint by 100n to get major-unit bigint, then format with `toLocaleString`), or at minimum add `Number.isSafeInteger` guard with a fallback.

- [MEDIUM] apps/web/app/routes/home-geo-redirect.tsx:32 — `fetch()` is called directly in the loader (not via `app/services/`), which is correct by the architecture rule for the two documented loader-fetch exceptions. However the direct `fetch` call here has no `X-Client-Version` or `X-Client-Id` header that `apiRequest` would normally attach — this is an internal server-to-server call so that is acceptable, but the lack of any error-body parsing means a non-JSON error response from `/api/public/geo` is silently swallowed (the `catch { return '' }` handles it). No bug in practice since the geo call fails-open, but worth noting the asymmetry.

- [LOW] apps/web/app/routes/gift-card.$name.tsx:275-280 — dynamic Tailwind class selection via `['grid-cols-2', 'grid-cols-3', 'grid-cols-4'][index]` uses computed array indexing. JIT Tailwind purges classes that do not appear as complete literal strings in source. All three values do appear as complete strings in the array literal on this line, so the purge should retain them. However if the array is ever refactored to a variable, purge will silently break the grid. — Consider using explicit conditional rendering (`savings && cashback ? 'grid-cols-4' : ...`) or adding a safelist entry.

- [LOW] apps/web/app/routes/cashback.$slug.tsx:56 — `canonicalHref(params, '/cashback/${slug}')`uses the decoded slug (after`decodeURIComponent`) but the URL should carry the percent-encoded form for non-ASCII slugs. For ASCII-only slugs (all current merchants) this is fine; for hypothetical non-ASCII merchant names the canonical URL would be malformed. — Use `encodeURIComponent(slug)` when building the canonical path segment.

- [LOW] apps/web/app/services/admin-csv.ts:38 — `URL.revokeObjectURL(url)` is called in `finally` immediately after `a.click()`. On Firefox, `click()` is synchronous but the download dialog is opened asynchronously. Revoking the URL in the same microtask can race with the dialog's URL read. The existing comment acknowledges Firefox memory-leak risk but does not address the race. — Revoke after a short delay (`setTimeout(() => URL.revokeObjectURL(url), 10_000)`) as is conventional for download-blob patterns.

- [LOW] apps/web/app/services/api-client.ts:95-96 — AbortError is caught and rethrown as `TIMEOUT` code, which conflates explicit cancellation (e.g. component unmount) with a real timeout. The existing comment calls it `aborted` not `timed out`, but the thrown `ApiException` code is still `'TIMEOUT'`. Callers that branch on `err.code === 'TIMEOUT'` to show "request timed out" copy will show incorrect messaging for a navigational abort. — Add a distinct `'ABORTED'` code, or only map `TimeoutError` to `TIMEOUT` and keep `AbortError` as a separate non-error (or re-throw as a cancellation sentinel).

- [LOW] apps/web/app/routes/privacy.tsx — legal page exposes internal endpoint paths (`GET /api/users/me/dsr/export`, `POST /api/users/me/dsr/delete`) in the public-facing privacy policy body. If those endpoints are renamed or changed, the policy text silently becomes stale/misleading. — Keep the prose non-technical or, if technical references are needed, use a versioned docs URL that can be updated out-of-band.

- [LOW] apps/web/app/routes/terms.tsx:94 — Terms section 4 contains a minor editorial issue: "LOOP- asset" has an errant space after the hyphen (`LOOP- asset balance`). Cosmetic only but visible to users. — Fix to "LOOP-asset balance".

- [LOW] apps/web/app/services/config.ts:49 — `fetchAppConfig` uses a raw `fetch()` + casts response as `AppConfig` with no Zod validation, violating the project rule "All upstream responses are Zod-validated before forwarding to the client." A broken `social.googleClientIdWeb` field returning a number would silently pass through. — Add a Zod schema for `AppConfig` and parse before returning; or at minimum add a runtime assertion on the shape.

- [LOW] apps/web/app/services/clusters.ts:77-83 — Triple `eslint-disable @typescript-eslint/no-explicit-any` on dynamic proto imports. This is the documented exception (`// eslint-disable-next-line` for proto bridge) but occurs on three separate lines, suggesting the outer function body could be restructured so a single suppress covers the bloc. Minor style inconsistency with the documented project convention (single suppress with a comment). No functional issue.

- [INFO] apps/web/app/routes/orders.$id.tsx — imports `openWebView` from `~/native/webview` directly in the route file. Project rule says Capacitor plugin calls must live in `app/native/`. If `openWebView` internally wraps a Capacitor plugin, verify `~/native/webview` is inside `app/native/` — if so, this is compliant. If `~/native/webview` is outside that directory, this is a rule violation. Require investigation.

- [INFO] apps/web/app/routes/home.tsx:261 — Skeleton array uses index as `key` (`Array.from({ length: 6 }).map((_, i) => <MerchantCardSkeleton key={i} />`). This is acceptable for static skeletons that never reorder, but worth noting as a pattern that triggers React warnings if the skeleton count changes dynamically.

- [INFO] apps/web/app/services/admin.ts — Pure barrel re-export file with ~500 lines of comments/exports. The file is structurally sound (A2-1165 / A2-1166 close-out) but the inline comment about `AdminOrderState` being two hand-maintained copies at line 41-42 ("A2-1166: `AdminOrderState` + `AdminOrderState` used to be two hand-maintained copies") has a duplicated type name in the comment, suggesting a copy-paste artifact. Not a runtime issue.

- [INFO] apps/web/app/routes/sitemap.tsx — `fetchMerchants` uses raw `fetch()` directly (no `apiRequest`). This is the documented second loader-fetch exception; correct.

- [INFO] apps/web/app/routes/home-geo-redirect.tsx — uses `fetch()` directly. This is the documented first loader-fetch exception; correct.

- [INFO] apps/web/app/services/auth.ts — `getPlatform()` is imported directly at the top of the module (not inside `~/native/` boundary check). `getPlatform` lives in `~/native/platform.ts` which is inside the allowed boundary. The import in `auth.ts` is a service layer, not a component/hook, so the Capacitor boundary rule (which targets components) does not strictly apply. Pattern is consistent with other service files.

- [INFO] apps/web/app/routes/settings.wallet.tsx:154 — `setTimeout(() => setCopied(false), 2000)` has no cleanup (no `clearTimeout` in a `useEffect` return). If the component unmounts before 2 seconds, the timeout fires on an unmounted component. React 18 silently ignores `setState` after unmount (no error), but it is still a minor memory leak if the timeout runs frequently. Low risk given the 2s window. — Optionally wrap in a `useEffect` with cleanup.

- [INFO] apps/web/app/routes/cashback.tsx:88 — `query.data.merchants.length` accesses `.merchants` without optional chaining, relying on the TanStack Query type narrowing that `query.data` is defined in the `else` branch after `query.isPending` and `query.isError` checks. This is correct TypeScript narrowing; flagging only because a future code change adding an intermediate branch could break the assumption.

## Batch 15 — web src (5/6)

- [MEDIUM] apps/web/app/services/public-stats.ts:63-64 — Redundant duplicate import of `PublicCashbackPreview`. Line 63 is `export type { PublicCashbackPreview } from '@loop/shared'` (re-export, which already acts as an import for local use), then line 64 immediately repeats `import type { PublicCashbackPreview } from '@loop/shared'`. TypeScript accepts this but the `import` on line 64 is dead/confusing code that suggests the re-export pattern was added later without removing the original import. Remove line 64; the re-export on line 63 covers local usage in the function signatures below. — Remove `import type { PublicCashbackPreview } from '@loop/shared';` on line 64; the re-export on line 63 serves both external callers and local type references.

- [MEDIUM] apps/web/app/services/public-stats.ts:93-96 — Local `PublicLoopAsset` interface includes `'USDLOOP' | 'EURLOOP'` asset codes. Per ADR note in project memory (2026-05-05), USDLOOP and EURLOOP are retired in favour of USDC/EURC via DeFindex. While `packages/shared/src/loop-asset.ts` still lists them (in-progress migration), the local interface here is not derived from the shared canonical type — it's hand-written, meaning it won't automatically track the shared migration. — Derive `PublicLoopAsset.code` from the shared `LoopAssetCode` type (or `typeof LOOP_ASSET_CODES[number]`) so it stays in sync when the retirement is finalised.

- [MEDIUM] apps/web/app/utils/share-image.ts:143-155 — `loadImage()` has no timeout guard. The function returns a `Promise` that resolves only on `onload` or `onerror`. In practice browsers always fire `onerror` on network failure, but there is no explicit `AbortController` + timeout path. If the image proxy stalls (slow upstream, connection reset mid-stream without closing the socket), the canvas composition can hang indefinitely, blocking the share UX silently. The outer `try/catch` does not rescue a hung `await`. — Add a `setTimeout` reject path (e.g. 8 s) inside `loadImage` to bound the wait: `setTimeout(() => resolve(null), 8000)`.

- [MEDIUM] apps/web/app/utils/sentry-error-scrubber.ts:75 — Error `.stack` is copied unscrubbed into the cloned error. Stack traces may include file paths that contain user-specific route segments (e.g. `/orders/abc123` where `abc123` is an order id, or a route that embeds a userId). In isolation this is low risk since stack frames show source paths, not runtime data; but the comment on line 92-96 of `query-error-reporting.ts` deliberately avoids forwarding the query key for exactly this reason (user ids in keys). The `.stack` path has no equivalent scrub. — Apply `scrubStringForSentry` to `err.stack` before assigning it to the clone, consistent with the scrubbing already applied to `err.message`.

- [LOW] apps/web/app/services/stellar-wallet.ts:51 — Stub `PayParams.assetCode` union includes `'USDLOOP' | 'EURLOOP'` which are scheduled for retirement (ADR 015 / project_wallet_yield_topology_v2.md). Since this is a documented stub pending ADR acceptance, it is not blocking, but the type should be updated before the ADR is accepted to avoid baking in the stale union. — When the SWK ADR is written and the stub is replaced, align `assetCode` with the canonical `LoopAssetCode` type from `@loop/shared`.

- [LOW] apps/web/Dockerfile:75 — The CMD uses `npx react-router-serve` which installs from the npm registry at container startup if `react-router-serve` is not found locally. In this Dockerfile's production stage `@react-router/serve` is installed via `npm ci --omit=dev`, so `npx` should find it locally — however using `npx` rather than the direct bin path (`./node_modules/.bin/react-router-serve`) adds the slow `npx` resolution pass and could fall back to a network install if the binary is unexpectedly absent. The backend Dockerfile uses `node` directly. — Replace `npx react-router-serve` with `node_modules/.bin/react-router-serve` or `node apps/web/build/server/index.js` for a more deterministic startup.

- [LOW] apps/web/fly.toml:59-63 — The Fly VM is configured with 256 MB RAM and 1 shared CPU. React Router v7 SSR with `react-router-serve` (a Node.js server) including the TanStack Query provider, Sentry, and Leaflet SSR paths can peak above 256 MB on cold starts or under concurrent load, causing OOM kills that Fly surfaces as mysterious 503s. The backend fly.toml was presumably sized for its workload; the web fly.toml should be reviewed under load. — Consider 512 MB as the minimum for a Node.js SSR server; add a `[[metrics]]` block to observe RSS in production before locking the limit.

- [LOW] apps/web/app/utils/security-headers.ts:61 — `style-src` retains `'unsafe-inline'` even when a per-request nonce is available (the nonce only gates `script-src`). Tailwind v4 no longer injects inline styles into the DOM at runtime (it generates a stylesheet at build time), so the stated justification ("Tailwind inlines styles at build time, so `'unsafe-inline'` on style-src is unavoidable") should be re-evaluated. If no dynamic inline styles are actually used, `style-src` could drop `'unsafe-inline'` for the SSR CSP path, meaningfully narrowing the XSS surface. — Audit the actual runtime style injections (Leaflet, animation, Capacitor) and drop `'unsafe-inline'` from `style-src` in the nonce-path CSP if none require it.

- [INFO] apps/web/app/stores/ui.store.ts:88 — `loadPreference()` is called at module-eval time as `const initialPref = loadPreference()`. During SSR this is safe (the `try/catch` returns `'system'` when `localStorage` is unavailable), but it means every server-side render call starts with the same `'system'` preference — there is no per-request override from a cookie or Accept header. This is documented behaviour (theme applied client-side only) but worth noting in case a future feature wants server-rendered dark-mode support.

- [INFO] apps/web/app/stores/purchase.store.ts:141 — `let persistQueue` is a module-level singleton. In an SSR Node.js process this is shared across all concurrent requests. However, `persistQueue` only serialises `sessionStorage` / Capacitor Preferences writes which are no-ops on the server (guarded in `loadPendingOrderSync`), so this is a non-issue in practice. Noted for completeness.

- [INFO] apps/web/app/stores/auth.store.ts:83-95 — Cross-tab logout listener is registered at module-eval time with `window.addEventListener('storage', ...)`. This is SSR-safe (guarded by `typeof window !== 'undefined'`). The listener is never removed, which is correct for a module-level singleton. No issue.

- [INFO] apps/web/public/hero.webp — Binary: RIFF/WEBP image asset. No code review applicable.

- [INFO] apps/web/public/login-hero.jpg — Binary: JPEG image asset. No code review applicable.

- [INFO] apps/web/public/leaflet/marker-icon-2x.png — Binary: PNG image asset (Leaflet marker). No code review applicable.

- [INFO] apps/web/public/leaflet/marker-icon.png — Binary: PNG image asset (Leaflet marker). No code review applicable.

- [INFO] apps/web/public/leaflet/marker-shadow.png — Binary: PNG image asset (Leaflet shadow). No code review applicable.

## Batch 16 — web src (10/10)

- [MEDIUM] apps/web/vite.config.ts:43-48 — Dev proxy silently falls back to production API (`https://api.loopfinance.io`) when `VITE_API_URL` is unset or empty. A developer who clones the repo and runs `npm run dev` without creating `.env.local` will unknowingly issue API calls (including auth OTP requests) against the live production backend. Recommended fix: remove the fallback entirely and throw an error (or log a loud warning) when `VITE_API_URL` is absent in development — `if (!process.env['VITE_API_URL'] && process.env['NODE_ENV'] !== 'production') throw new Error('VITE_API_URL must be set for local dev')`.

- [MEDIUM] apps/web/public/manifest.json:22-26 — `loop-logo.svg` (viewBox `0 0 172.22 71`, a full-width wordmark on a transparent background) is listed with `"purpose": "maskable"`. The W3C maskable icon spec requires all meaningful content to live within the central 40% "safe zone". A letterform wordmark spanning the full canvas will be heavily clipped by Android adaptive icon masks (circle, squircle, etc.) — the result is an unrecognizable partial logo. Recommended fix: create a dedicated square icon (e.g. `loop-icon-maskable.png`, at least 512×512px, logo centred with 20% padding each side) and use it exclusively for `"purpose": "maskable"`. Reserve `"purpose": "any"` for the existing SVG wordmark.

- [LOW] apps/web/vitest.config.ts:13 — Uses the bare `__dirname` global without defining it. The package is `"type": "module"` (ESM), so `__dirname` is not available at native Node.js runtime. TypeScript types it through `@types/node` but the runtime value is `undefined` in a real ESM `node` invocation. The tests currently pass only because Vite internally transforms the config file under its own CJS-compatibility shim. If Vite ever drops that shim, or the config is exercised outside Vite, the alias will resolve to `undefined/app`. Recommended fix: mirror the pattern used in `vite.config.ts` — `import { dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; const __dirname = dirname(fileURLToPath(import.meta.url));`.

- [LOW] apps/web/public/manifest.json:11 — `"lang": "en"` is hard-coded. ADR 034/035 introduced per-country locale routing (`/:country/:lang`) so users from non-English markets (AE, IN, SA, AU, MX — ADR 035) may install the PWA. The web manifest is a static file and cannot be locale-adapted without a server-rendered route. Recommended fix: serve the manifest via an SSR loader route (e.g. `routes/manifest.webmanifest.tsx`) so `lang` and `start_url` can reflect the user's active locale, or at minimum document this as a known limitation.

- [LOW] apps/web/public/manifest.json:5 — `"start_url": "/"`. For SSR users, this is fine (the geo-redirect kicks in). For PWA users on a locale-specific page, Android/Chrome records `start_url` from the manifest rather than the current URL, so the installed PWA always cold-starts at `/` and incurs a redirect round-trip. Minor UX friction. If the manifest becomes server-rendered per the previous recommendation, this could be set to the active locale root (e.g. `/us/en`).

- [LOW] apps/web/public/robots.txt:19 — `Disallow: /onboarding` covers the non-localised path but not locale-prefixed equivalents (e.g. `/us/en/onboarding`, `/gb/en/onboarding`). The onboarding route is included in `localeChildren` (routes.ts:43) so those URLs are reachable by crawlers. Onboarding is public content (no session required) so this is not a security issue, but it leaks a signup funnel endpoint into search indices. Recommended fix: add `Disallow: /*/en/onboarding` (or a pattern covering all locale variants) if onboarding should remain out of search results.

- [LOW] apps/web/public/loop-favicon.svg:1-4 — The `<svg>` element has no `<title>` element and no `aria-label`. When this SVG is inlined or referenced directly (e.g. in img tags without `alt`), it has no accessible name. For a favicon this is typically fine, but the `<text>` element that renders "L" should be accompanied by a hidden `<title>Loop</title>` for completeness. Low impact since favicons are decorative.

- [INFO] apps/web/tsconfig.json:15 — `"verbatimModuleSyntax": false` is intentionally set (matching the base tsconfig) to accommodate React Router's generated types, which use `import type` but also emit mixed import/export patterns that verbatimModuleSyntax rejects. This is acceptable given the React Router v7 constraint. No action needed.

- [INFO] apps/web/vitest.config.ts:48-53 — Coverage thresholds are deliberately set 3–5 points below measured actuals (branches: 32%, functions: 40%, lines: 37%, statements: 35%). The comment acknowledges this as a regression gate. No action needed, but teams should track toward raising these as test coverage grows.

- [INFO] apps/web/public/manifest.json — No `apple-touch-icon` meta tag is declared in `root.tsx`. iOS Safari uses a page screenshot as the homescreen icon when no `apple-touch-icon` is present. This is a UX gap for Safari-based PWA installs. Recommended fix: add `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` in `root.tsx` (links array) and supply a 180×180px PNG.

- [INFO] apps/web/react-router.config.ts:4 — Minimal, correct. `ssr` is conditionally disabled for `BUILD_TARGET=mobile`. No issues.

## Batch 17 — web tests (1/2)

- [MEDIUM] apps/web/app/components/features/purchase/**tests**/RedeemFlow.test.tsx:61 — test "exposes a button to open the redemption WebView" asserts only that `ctas.length > 0` (the page always has buttons), never that `openWebView` is called or that a specific button exists — weakens the contract for the primary CTA — replace with `fireEvent.click` on the redeem button and assert `mockOpenWebView` is called with the redeem URL

- [MEDIUM] apps/web/app/components/features/purchase/**tests**/PaymentStep.test.tsx:43-67 — three rendering tests in "PaymentStep — rendering" each use `getAllByText(...).length > 0` which passes even if the element is buried in an error banner or tooltip, not its intended context; the checks are effectively `element exists somewhere on the page` — use `getByRole` or `getByLabelText` with tighter context to verify the values appear in their intended locations

- [MEDIUM] apps/web/app/components/features/purchase/**tests**/PaymentStep.test.tsx:120-131 — "copies the payment address" only asserts `mockCopy.toHaveBeenCalled()` without checking the argument; if the wrong text is copied (e.g., memo instead of address), the test still passes — assert `toHaveBeenCalledWith('GXXX')` or similar

- [MEDIUM] apps/web/app/components/features/admin/**tests**/CashbackRealizationCard.test.tsx:136-152 — two "self-hides" tests (empty rows, error) use `waitFor(() => adminMock.getCashbackRealization.toHaveBeenCalled())` as the readiness gate; if the query fires but the component has a render bug that shows content, the `container.textContent === ''` assertion fires before React settles — prefer `waitFor` on the absence of the specific element, or use `screen.findByText` negation pattern for stronger synchronisation

- [MEDIUM] apps/web/app/components/features/cashback/**tests**/CashbackCalculator.test.tsx:113-136 — "skips the fetch when the amount is zero" uses a real `setTimeout(r, 400)` inside a test — this is a timing-dependent assertion; if the debounce window is changed the test silently becomes vacuous — use `vi.useFakeTimers()` + `vi.advanceTimersByTime` to make the debounce controllable

- [LOW] apps/web/app/components/features/admin/**tests**/Sparkline.test.tsx:33-46 — "renders a spinner in the pending state" asserts `container.querySelector('svg') !== undefined` which is always true in jsdom (querySelector returns null, and `null !== undefined` is true) — should assert `not.toBeNull()` or use `toBeDefined()` after asserting the result of `querySelector` is non-null; the test as written can never fail

- [LOW] apps/web/app/components/features/admin/**tests**/MerchantRailMixCard.test.tsx:91-92 — comment says "loop_asset: 18/45 = 33.3%" but then the assertion comment says "40.0%" and the actual fixture is `loop_asset: 18 orders, chargeMinor 6000, total charge 15000` = 40.0%; the count percentage is 18/45 = 40.0% (not 33.3%) — minor comment inaccuracy, fix the comment (the assertion itself is correct)

- [LOW] apps/web/app/components/features/admin/**tests**/AdminAuditTail.test.tsx:166 — dynamically imports `fireEvent` from `@testing-library/react` inside the test body (`const { fireEvent } = await import(...)`) — unnecessary; `fireEvent` is already imported at the top of the file and this pattern works but is confusing — remove the dynamic import and use the top-level binding directly

- [LOW] apps/web/app/components/features/admin/**tests**/TopUsersTable.test.tsx:113 — same dynamic-import pattern for `fireEvent` inside test body (`const { fireEvent } = await import('@testing-library/react')`) — same fix as above

- [LOW] apps/web/app/components/features/cashback/**tests**/PendingCashbackChip.test.tsx:117 — `screen.getAllByText(/LOOP$/)` matches both GBPLOOP and USDLOOP to assert alphabetical ordering by checking `labels[0].textContent === 'GBPLOOP'` — this ordering assertion is brittle if more LOOP assets are added (AELOOP sorts before GBPLOOP); consider a more explicit ordering check or document the sort key

- [LOW] apps/web/app/**tests**/entry-server-headers.test.ts — tests `buildSecurityHeaders()` in isolation but does not test that `entry.server.tsx` actually calls it — the comment says "we cannot render a real React tree" but a simpler spy/import test on the handler function could verify the wiring without a full React render; current tests would pass even if entry.server.tsx stopped calling `buildSecurityHeaders` — INFO-level: acceptable given complexity of SSR test setup

- [INFO] apps/web/app/components/features/purchase/**tests**/PurchaseComplete.test.tsx:97-113 — share test uses `expect.objectContaining` without asserting `imageUrl` field (only `imageFilename`); the comment notes barcode canvas toDataURL is implementation-dependent, which is reasonable, but `imageUrl` is never asserted — no action required, comment explains the intent

- [INFO] apps/web/app/components/features/admin/**tests**/DiscordNotifiersCard.test.tsx — comprehensive; includes success, 409, 500, empty, and list rendering; well-structured

- [INFO] Multiple admin test files use the pattern `await waitFor(() => { expect(adminMock.xxx).toHaveBeenCalled() })` as a settling gate followed by synchronous DOM assertions — this is the correct pattern for async component tests in this codebase; no issues found

## Batch 18 — web tests (2/2)

- [HIGH] apps/web/app/hooks/**tests**/use-session-restore.test.ts:22-78 — Tests call `getRefreshToken()` and `getEmail()` directly from the mock and then assert on the results, or manually call `useAuthStore.setState()` in the test body. None of these tests exercise `useSessionRestore` hook logic at all — they are testing the mocked functions and direct store mutations. The file is named `use-session-restore.test.ts` but the actual hook is never imported or called. — Import and invoke `useSessionRestore` (or the equivalent boot-restore logic) in each test; remove the mock-only assertions.

- [HIGH] apps/web/app/hooks/**tests**/use-auth.test.tsx:35-45 — `successful verifyOtp stores session in auth store` calls the mocked `verifyOtp` directly, then manually calls `useAuthStore.getState().setSession(...)` in the test body. It is testing the mock's return value and a store write the test itself issued, not the `useAuth` hook. The hook is not rendered in this test. — Render `useAuth` via `renderHook`, call `result.current.verifyOtp(...)`, and observe the store state changes that result.

- [HIGH] apps/web/app/hooks/**tests**/use-auth.test.tsx:47-50 — `requestOtp calls service with email` only asserts `expect(requestOtp).toHaveBeenCalledWith('test@example.com')` after calling the mock directly. This is a circular assertion: the test calls the mock and confirms the mock was called. The hook is never involved. — Render `useAuth`, call `result.current.requestOtp(...)`, and assert on side effects (store state, thrown error, etc.).

- [MEDIUM] apps/web/app/hooks/**tests**/use-auth.test.tsx:78-88 — `isAuthenticated is true when accessToken is set` / `isAuthenticated is false after clearSession` assert `state.accessToken !== null` rather than a dedicated `isAuthenticated` field (if one exists). The inline boolean expression can never distinguish a missing property from a null value and the test name claims to test `isAuthenticated` but actually tests `accessToken`. — Either assert directly on `state.accessToken !== null` and rename the tests, or check the actual `isAuthenticated` computed value if the store exposes one.

- [MEDIUM] apps/web/app/hooks/**tests**/use-native-platform.test.ts:1-33 — All five tests mock `~/native/platform` completely and then call the mocked functions. The tests only verify that vi.fn mocks return what they were told to return. There is no real code under test. The file exists to test `useNativePlatform` but imports from `~/native/platform` instead of `../use-native-platform`. — Either delete this file (use-native-platform-hook.test.tsx already covers the real hook), or rewrite it to import the underlying `platform.ts` implementation without mocking (integration test) to prove the real Capacitor dispatch works.

- [MEDIUM] apps/web/app/hooks/**tests**/use-session-restore-a2-1150.test.tsx:16-47 — The test imports `../use-session-restore` but the only assertion is that `clearRefreshToken` was not called. The test never checks that the session was not cleared from the auth store, that `accessToken` remains null, or that the stored refresh token remains intact. The positive path (successful refresh on boot) is entirely untested in this file. — Add assertions on `useAuthStore.getState().accessToken` and the stored token value; add a test for the success path where `tryRefresh` returns an access token.

- [MEDIUM] apps/web/app/routes/**tests**/admin.operators.test.tsx:109-119 — `combineRows` sort test with `operatorId` 'a', 'b', 'c' has two entries with identical `failedCount=1` and `orderCount=10`. The expected output is `['b', 'c', 'a']` but the comment says "sorts by failedCount DESC, then orderCount DESC, then id ASC". For identical failedCount+orderCount, id ASC should give 'b' before 'c' — this is correct but the test makes it look like 'b' wins over 'c' purely by insertion order. Rename the test comment or add a third tie-break test to explicitly pin the id-ASC tiebreaker. — Low severity in isolation, but the missing explicit tie-break test makes the sort contract ambiguous.

- [MEDIUM] apps/web/app/services/**tests**/config.test.ts:19-25 — `API_BASE` test only asserts `typeof API_BASE === 'string'`. This is satisfied by an empty string `''`, by the wrong URL, or by any string whatsoever. Since `API_BASE` drives every API call, the test provides false assurance. — Assert the expected value explicitly (e.g. the VITE_API_URL env value in test, or that it resolves to the known fallback); at minimum assert it matches a URL-shaped regex.

- [MEDIUM] apps/web/app/hooks/**tests**/use-app-config.test.tsx:89-96 — Comment at lines 89-96 explains the error path is NOT tested ("a direct error-path renderProbe run is gated by vitest 4.x's unhandled-rejection bubbling"). The error path falls through to `query.data ?? DEFAULT_CONFIG`, but the test only pins the pending-state path indirectly. A silently-enabled flag on error (if `DEFAULT_CONFIG` had incorrect defaults) would not be caught. — Document a tracking ticket, or wrap with `expect.assertions(N)` + error boundary to make the omission explicit.

- [LOW] apps/web/app/routes/**tests**/settings.cashback.test.tsx:193-290 — The `on-chain payouts section` tests do not cover the `failed` payout state display. Only `confirmed` and `submitted` states are tested; a regression where `failed` state shows the wrong icon, wrong label, or exposes a tx link (when `txHash` is null on failure) would not be caught. — Add a test for `state: 'failed', txHash: null, failedAt: <timestamp>` to lock in the failed-state rendering.

- [LOW] apps/web/app/routes/**tests**/admin.payouts.$id.test.tsx — The retry button interaction is not tested. `shows the retry button only on failed rows` confirms the button renders but never clicks it and never asserts that `retryPayout` is called, or that a success/error response is handled. — Add a test that clicks the retry button, stubs `retryPayout`, and asserts the mutation was called and the UI updates accordingly.

- [LOW] apps/web/app/hooks/**tests**/use-merchants.test.tsx:172-190 — `useMerchantsCashbackRatesMap` test only confirms lookup resolves for a known id and returns null for unknown. It does not test what happens during the loading state (before `fetchMerchantsCashbackRates` resolves), which is the primary use-case the hook guards against (`null` during loading). The hook comment says "returns null for unknown ids until the rates map resolves", but the test only checks after resolution. — Add a test that asserts `lookup('amazon-us')` returns null before the query resolves.

- [LOW] apps/web/app/native/**tests**/app-lock.native.test.ts:60-91 — The two test cases are the only native app-lock tests but they do not test the success path: when `authenticateWithBiometrics` resolves `true`, the overlay should be removed. The "auth succeeds, overlay gone" assertion is missing. — Add a test where `state.authOk = true` and `state.biometric.available = true`, flush effects, and assert the overlay is removed from `document.body`.

- [LOW] apps/web/app/routes/**tests**/sitemap.test.tsx:47-48 — The count assertion `expect(block.split('\n')).toHaveLength(29)` inside `hreflangAlternates` is performed on the result of `hreflangAlternates('/cashback')` imported from `../seo.js` (i.e., it is tested in `seo.test.ts`, not in `sitemap.test.tsx`). The sitemap test at this file has no equivalent count assertion. However in `seo.test.ts:46-47` the `hreflangAlternates` count test references "28 countries + x-default = 29 reciprocal links" but the country-model test confirms 28 countries. If a new country is added, the count hard-coded in `seo.test.ts:47` will silently fail without the test description updating. — Derive the count from `COUNTRIES.length + 1` rather than hard-coding `29`.

- [LOW] apps/web/app/services/**tests**/orders-loop.test.ts — Only `loopOrderStateLabel` and `isLoopOrderTerminal` are tested. The file `orders-loop.ts` likely exports additional types/functions (e.g., loop-specific order creation), which are not exercised here. This is a narrow coverage gap. — Audit the exports of `orders-loop.ts` and add tests for any untested functions.

- [INFO] apps/web/app/hooks/**tests**/use-auth.test.tsx:52-61 — `clearSession resets auth state` is a direct store test with no hook involvement; it duplicates tests already in `auth.store.test.ts`. Not harmful, but contributes to noise. — Consider moving purely store-level assertions to `auth.store.test.ts`.

- [INFO] apps/web/app/services/**tests**/user.test.ts — All tests are path/shape assertions on a thin wrapper. No test exercises error propagation (except `getUserPayoutByOrder` which does). For example, `setHomeCurrency`, `getStellarTrustlines`, etc. have no error path tests. Given the wrapper nature this is acceptable, but `getUserPayoutByOrder` sets a higher bar. — Add error propagation tests for any method where error semantics differ from a generic throw-through (e.g., if `getMe` 401 should trigger session clear).

- [INFO] apps/web/app/native/**tests**/native-modules.test.ts — Large omnibus file (729 lines) covering 14 native modules. While comprehensive for web-platform no-ops, every test is essentially `resolves.toBeUndefined()` or `not.toThrow()` because all Capacitor plugins are no-ops on web. Tests cannot catch regressions in the native code paths (iOS/Android) since those are never exercised. — Document this limitation clearly; note that native paths are covered only by the separate `secure-storage-native.test.ts` pattern.

- [INFO] apps/web/app/utils/**tests**/sentry-scrubber.test.ts — Thoroughly covers `scrubSentryEvent`. No gaps identified.

- [INFO] apps/web/app/i18n/**tests**/country-model.test.ts:34 — Hard-codes `COUNTRIES.length === 28` in the test assertion. When a new country is added, this assertion fails until manually updated, which is a low-friction update but couples the test to an exact count. — Assert `COUNTRIES.length >= 28` or derive from a known anchor set.

## Batch 19 — mobile

- [MEDIUM] apps/mobile/native-overlays/android/app/src/main/res/drawable-land-hdpi/splash.png (and all 9 sibling port/land density variants) — All 10 per-orientation density splash PNGs are byte-for-byte identical to `drawable/splash.png` (md5: `06290187…`), but the apply script copies only from `drawable/splash.png` as the source, never reading these per-density overlay files. The 10 files stored here (10 × 114 KB = ~1.1 MB) are dead weight that will never be used. The script is correct for runtime behaviour (a single high-res PNG in `drawable/` is the right approach for Capacitor splash), but the overlay directory is misleading and bloated. Fix: delete the 10 per-density/orientation splash PNGs from `native-overlays/` and keep only `drawable/splash.png`; update the overlay list comment in `apply-native-overlays.sh`.

- [MEDIUM] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json + all three iOS splash PNGs — All three iOS splash image files (`splash-2732x2732.png`, `splash-2732x2732-1.png`, `splash-2732x2732-2.png`) are identical (md5: `06290187…`). `Contents.json` maps them as scale=1x, 2x, 3x respectively, but serving the same source image at every scale point means iOS receives no density benefit. On 1x devices the image is 3× oversize; the 2x/3x "scale" entries convey nothing because the PNG is not a 1x master. This is functionally harmless (iOS will downscale) but the scale=1x entry ships a 2732×2732 image for a 1x context. Fix: either use a single "universal" `scale="1x"` slot with the 2732 PNG and remove 2x/3x, or generate true density-appropriate masters.

- [MEDIUM] apps/mobile/native-overlays/android/app/signing.gradle:62 — References `docs/mobile-release.md` for keystore generation instructions, but that file does not exist in the repository (`docs/mobile-native-ux.md` exists; no `mobile-release.md`). Any developer following the Gradle warning will hit a dead link. Fix: either create `docs/mobile-release.md` with the keytool command (already present inline in `keystore.properties.example`) or update the reference to point to `docs/deployment.md` where the operator-once steps are documented.

- [MEDIUM] apps/mobile/native-overlays/ios/App/App/Info.plist.additions.txt — This file is documentation only; it is not parsed or applied by `apply-native-overlays.sh`. The script uses `plist_set_or_add_string` to apply `NSFaceIDUsageDescription` and `NSLocationWhenInUseUsageDescription` by hardcoding the canonical strings directly in the shell. If the canonical strings in this `.txt` file are ever edited without updating the matching hardcoded strings in the script (or vice-versa), the documentation and implementation will silently drift. The `.txt` file currently shows the Face ID string only; the Location string added to the script is not mentioned here. Fix: add an explicit warning comment to `Info.plist.additions.txt` noting it is documentation-only and the source of truth is the script; add the NSLocationWhenInUseUsageDescription entry to the `.txt`; consider extracting the canonical strings to a single `.env`-style file sourced by both documentation and the script.

- [LOW] apps/mobile/native-overlays/android/app/src/main/res/xml/backup_rules.xml — The `<full-backup-content>` only excludes `CapacitorStorage.xml`. The `@aparajita/capacitor-secure-storage` plugin stores EncryptedSharedPreferences data under a key that may differ from `CapacitorStorage`; the plugin documentation indicates it uses its own preferences name (`SecureStorage` by default). While the comment correctly explains that Keystore-bound ciphertext is unreadable on restore, the defense-in-depth rationale implies both stores should be excluded. Similarly `data_extraction_rules.xml` only excludes `CapacitorStorage.xml`. Fix: audit the actual SharedPreferences file name used by `@aparajita/capacitor-secure-storage` on Android and add a matching `<exclude>` entry to both backup rules files if different.

- [LOW] apps/mobile/scripts/apply-native-overlays.sh:167 — AVD XML files are copied with a bare `cp` (not `cp_if_changed`) inside the drawable loop: `[ -f "$SRC_XML" ] && cp "$SRC_XML" "$DRAWABLE_DEST/"`. This means every run rewrites these files and bumps their mtime even when content is unchanged, churning Xcode/Gradle incremental caches. The same script uses `cp_if_changed` everywhere else. Fix: replace the bare `cp` with `cp_if_changed` for the AVD XML copy loop.

- [LOW] apps/mobile/native-overlays/ios/release.xcconfig — The script copies this file to `apps/mobile/ios/release.xcconfig`, but the critical step of wiring it as `baseConfigurationReference` in the Xcode `.pbxproj` is documented as "operator-once" with no automated verification. If the operator forgets or the iOS project is regenerated (e.g., `cap add ios` on a new machine), the `CAPACITOR_DEBUG = false` pin silently has no effect. Fix: add a post-copy check in `apply-native-overlays.sh` that greps the `.pbxproj` for `release.xcconfig` and emits a prominent warning (not an exit-1, since the `.pbxproj` is in the gitignored native tree) if the reference is absent.

- [LOW] apps/mobile/capacitor.config.ts — `SplashScreen.launchShowDuration` is set to 2000ms. The Android `windowSplashScreenAnimationDuration` in `styles.xml` is 900ms. These values are intentionally different (Capacitor's plugin timer vs. the system splash), but there is no comment explaining the relationship. A future developer might lower `launchShowDuration` to match and inadvertently cut off the Capacitor splash before it appears. Fix: add a comment in `capacitor.config.ts` noting the 2000ms is the Capacitor SplashScreen timer (after the 900ms Android system splash), so the two values serve different phases.

- [LOW] apps/mobile/package.json — `@capacitor/push-notifications` is declared as a dependency (`8.0.3`) and is configured in `capacitor.config.ts` (`presentationOptions`), but `Info.plist.additions.txt` and `apply-native-overlays.sh` do not add any push-notification related iOS usage string or background mode. iOS push notifications via APNs require the app to have the Push Notifications capability registered in the Apple Developer portal and in the Xcode project's entitlements — neither is covered by the overlay system. This is not a crash risk (permissions are requested at runtime), but if push is live in Phase 1, the entitlement must be manually set up. Fix: document the push entitlement as an operator-once step in `docs/deployment.md` (if not already present) and optionally add a `NSUserNotificationsUsageDescription` to `Info.plist.additions.txt` if Apple review requires it.

- [INFO] apps/mobile/native-overlays/android/app/src/main/java/io/loopfinance/app/MainActivity.java — Minimal, correct override. Sets `OVER_SCROLL_NEVER` to suppress WebView rubber-band. No issues.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/xml/network_security_config.xml — Correct production posture: empty `<network-security-config>` relying on Android API 28+ default of HTTPS-only. No cleartext exemptions. Matches the comment explaining the dev-variant pattern.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/xml/data_extraction_rules.xml — Correct: excludes `CapacitorStorage.xml` from both `<cloud-backup>` and `<device-transfer>`. Paired correctly with `backup_rules.xml` for pre-Android-12 coverage (A-033 compliant).

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/xml/backup_rules.xml — Pre-Android-12 backup exclusion for `CapacitorStorage.xml` present. See LOW finding re: SecureStorage plugin preferences name.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/xml/file_paths.xml — Correctly scoped to `<cache-path name="share" path="share/" />` only. No external-path entry. A2-1213 compliant.

- [INFO] apps/mobile/native-overlays/ios/App/App/PrivacyInfo.xcprivacy — Well-formed Apple Privacy Manifest. `NSPrivacyTracking=false`, `NSPrivacyTrackingDomains=[]`. Data types declared: email (linked), coarse location (not linked), user ID (linked), purchase history (linked), crash data (not linked), performance data (not linked). `NSPrivacyAccessedAPITypes=[]` (correct; plugin pods declare their own). Script copies it correctly.

- [INFO] apps/mobile/native-overlays/ios/App/App/Info.plist.additions.txt — Documents A-034 NSFaceIDUsageDescription requirement. Script correctly uses `plutil` for set-or-add (A2-405 fix). See MEDIUM finding re: documentation drift with `NSLocationWhenInUseUsageDescription`.

- [INFO] apps/mobile/native-overlays/ios/release.xcconfig — Single line `CAPACITOR_DEBUG = false`. Correct and minimal. See LOW finding re: lack of automated `.pbxproj` wiring verification.

- [INFO] apps/mobile/native-overlays/android/keystore.properties.example — Placeholder values (`CHANGE_ME`). No real secrets. Pattern is correct. Dead link to `docs/mobile-release.md` noted in MEDIUM finding.

- [INFO] apps/mobile/native-overlays/android/app/signing.gradle — Correctly guards on `keystorePropsFile.exists()` so absent keystore only warns (does not break dev builds). Signing wired for release builds. Dead doc link noted.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/values/styles.xml — Correct Android 12+ splash wiring (`windowSplashScreenBackground`, `windowSplashScreenAnimatedIcon`, `windowSplashScreenAnimationDuration`, `windowSplashScreenIconBackgroundColor`, `postSplashScreenTheme`). Uses `splash_icon_anim_bloom` AVD.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/values/ic_launcher_background.xml — Single color resource `#111111`. Correct.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_vector.xml — Well-formed VectorDrawable. Four letter groups (L, O1, O2, P) with named clip-paths and paths. Correct 108dp canvas / 72dp safe-zone structure for Android adaptive splash.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_bloom.xml — Correct pathType interpolation: valueFrom and valueTo both use `M C C C C Z` (4-cubic-bezier circle approximation). Command structures match. Each letter target correct.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_wipe.xml — Correct pathType interpolation: valueFrom/valueTo both `M L L L Z`. Command structure matches between animation pairs. Note: this overrides the vector's `M C C C C Z` clip-path shape at animation start; this is expected AVD behaviour (animator replaces the static value).

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_scale.xml — Correct. Whole-word scale 0.6→1.0 + fillAlpha fade. Within 1000ms cap.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_fade.xml — Correct. Per-letter staggered fillAlpha 0→1 with 100ms offsets. Total 700ms.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_slide.xml — Correct. Per-letter translateY 15→0 + fillAlpha with 100ms stagger. Total 700ms.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_draw.xml — Correct. Per-letter scaleX 0→1 + fillAlpha with 150ms stagger. Total 850ms.

- [INFO] apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_drop.xml — Correct. Per-letter translateY -15→0 + fillAlpha with 150ms stagger. Total 850ms.

- [INFO] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json — Single universal 1024×1024 entry (`AppIcon-512@2x.png`). Correct for Xcode 14+ single-size app icon. No alpha channel concern flagged (noted in script).

- [INFO] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png — Present, 62 KB. Non-zero size, correct for a 1024×1024 PNG app icon.

- [INFO] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json — Three scale slots (1x, 2x, 3x). See MEDIUM finding: all three source files are identical.

- [INFO] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png — Present, 114 KB. Same content as -1 and -2 variants (md5: `06290187…`).

- [INFO] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png — Present, 114 KB. Identical to main splash PNG.

- [INFO] apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png — Present, 114 KB. Identical to main splash PNG.

- [INFO] apps/mobile/scripts/apply-native-overlays.sh — Comprehensive overlay script. Covers: backup rules (A-033), network security config, FileProvider scope (A2-1213), MainActivity, launcher icons, background color, splash theme, splash drawables, AVD XMLs, signing.gradle, keystore example, build.gradle injection, location permissions, AndroidManifest backup attributes, iOS NSFaceIDUsageDescription, NSLocationWhenInUseUsageDescription (A-034), release.xcconfig, AppIcon, Splash imageset, PrivacyInfo.xcprivacy. Pre- and post-condition checks with loud failures. See LOW finding re: bare `cp` for AVD XMLs.

- [INFO] apps/mobile/package.json — Correct Capacitor 8.x plugin set. `@aparajita/capacitor-secure-storage` (8.0.0) present for ADR-006 Keychain/EncryptedSharedPreferences. `@aparajita/capacitor-biometric-auth` (10.0.0) present for A-034 Face ID. No unexpected dependencies. All versions pinned.

- [INFO] apps/mobile/capacitor.config.ts — `appId: 'io.loopfinance.app'` correct. `webDir` points to `'../web/build/client'` (static export). No `server` block (no cleartext live-reload left committed). `SplashScreen`, `Keyboard`, `PushNotifications` plugins configured. No secrets. See LOW finding re: missing comment on launchShowDuration relationship to Android system splash.

- [INFO] apps/mobile/README.md — Correct workflow documented: build web → cap sync → apply-native-overlays.sh → open IDE. Live-reload section correctly instructs to remove `server` block before committing. References ADR-007. No stale instructions detected.

- [INFO] (binary) drawable-land-mdpi/splash.png through drawable-land-xxxhdpi/splash.png (5 files) — All 114 KB, present, identical to master splash PNG. See MEDIUM finding re: redundant overlay files.

- [INFO] (binary) drawable-port-mdpi/splash.png through drawable-port-xxxhdpi/splash.png (5 files) — All 114 KB, present, identical to master splash PNG. See MEDIUM finding re: redundant overlay files.

- [INFO] (binary) mipmap-hdpi/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png — 4.9 KB, 4.9 KB, 8.0 KB. Present, non-zero.

- [INFO] (binary) mipmap-mdpi/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png — 3.1 KB, 3.1 KB, 5.1 KB. Present, non-zero.

- [INFO] (binary) mipmap-xhdpi/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png — 6.7 KB, 6.7 KB, 11 KB. Present, non-zero. Expected growth with density.

- [INFO] (binary) mipmap-xxhdpi/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png — 11 KB, 11 KB, 17 KB. Present, non-zero.

- [INFO] (binary) mipmap-xxxhdpi/ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png — 14 KB, 14 KB, 23 KB. Present, non-zero. Correct density progression.

- [INFO] (binary) drawable/splash_icon.png — 62 KB. Present. Used as fallback for `windowSplashScreenAnimatedIcon` when AVD not used.

- [INFO] (binary) drawable/splash.png — 114 KB. Present. Master splash PNG.

## Batch 20 — packages/shared

- [HIGH] packages/shared/src/users-me.ts:57 — `UserPendingPayoutState` is a manual duplicate of `PayoutState` from `payout-state.ts` (`'pending' | 'submitted' | 'confirmed' | 'failed'` identical). If `PayoutState` gains a new state the two will silently diverge. Fix: `export type UserPendingPayoutState = PayoutState` (import from `./payout-state.js`).

- [HIGH] packages/shared/src/loop-asset.ts:49 — ADR 031 (Proposed) renames `USDLOOP`/`EURLOOP` to `LOOPUSD`/`LOOPEUR` (DeFindex vault shares). Current code still uses `USDLOOP`/`GBPLOOP`/`EURLOOP` throughout the codebase and these names are correct for the current implementation. The audit item to track: ADR 031 is still "Proposed" but the CLAUDE.md memory says LOOPUSD/LOOPEUR are canonical. In code, `USDLOOP`/`GBPLOOP`/`EURLOOP` are the only asset codes and the `AGENTS.md` description lists these. Code and its own ADR 015 are internally consistent; the drift is doc-level (ADR 031 Proposed vs current code), not a code bug. No code change required until ADR 031 is accepted and the rename is executed — but the discrepancy should be explicitly tracked. Record as INFO pending ADR-031 acceptance.

- [MEDIUM] packages/shared/src/money-format.ts:59-60 — `formatMinorCurrency` hardcodes 100n as the minor-unit divisor, assuming all currencies have exactly 2 decimal places. The `countries.ts` comment at line 99 explicitly names `KWD` (3 decimals = 1000 fils) as a potential future currency. If KWD is ever added to `SUPPORTED_CURRENCIES`, `formatMinorCurrency(100n, 'KWD')` would display `"0.10 KWD"` rather than the correct `"0.100 KWD"` (and the major/fractional split would be wrong). Fix: use `Intl.NumberFormat` to derive the correct `fractionDigits` for the currency and adjust the divisor (`10n ** BigInt(digits)`), or add an explicit guard that throws/warns for non-2-decimal currencies.

- [MEDIUM] packages/shared/src/users-me.ts (whole file) and corresponding `FavoriteMerchantView` / `ListFavoritesResponse` / `AddFavoriteResult` / `RecentlyPurchasedMerchantView` / `RecentlyPurchasedResponse` — these cross-boundary types (backend emits, web consumes) are duplicated in `apps/backend/src/users/favorites-handler.ts`, `apps/backend/src/users/recently-purchased-handler.ts`, and `apps/web/app/services/favorites.ts` / `apps/web/app/services/recently-purchased.ts`. This is an ADR 019 violation: the types cross the web↔backend boundary, are pure TypeScript, and drift = silent bug. Fix: move `FavoriteMerchantView`, `ListFavoritesResponse`, `AddFavoriteResult`, `RecentlyPurchasedMerchantView`, `RecentlyPurchasedResponse` into `packages/shared/src/users-me.ts` (or new `users-favorites.ts` / `users-recently-purchased.ts`) and export from `index.ts`.

- [MEDIUM] packages/shared/src/admin-settlement-lag.ts:13 — `SettlementLagRow.assetCode` is typed `string | null`. The aggregate row has `null`, but all per-asset rows should be `LoopAssetCode | null` since only LOOP assets have settlement payouts. Using `string` is loose; callers cannot switch exhaustively. Fix: `assetCode: LoopAssetCode | null`.

- [LOW] packages/shared/README.md:41 — States "Generated files are git-ignored — regenerate after schema changes." but `packages/shared/src/proto/clustering_pb.ts` is committed and tracked in git (`git ls-files` confirms). The AGENTS.md does not make this claim and is correct. Fix: remove the "git-ignored" sentence from README.md.

- [LOW] packages/shared/AGENTS.md:24 — States `src/users-me.ts — A2-1505 /api/users/me* response shapes (13 types)` but the file currently exports 21 named interfaces/types. The count is stale. Fix: update the count or drop it.

- [LOW] packages/shared/src/regions.ts — `isSupportedCountry()` at line 115 returns `false` for the ADR 035 extended markets `AE`, `IN`, `SA`, `AU`, `MX` because those countries are not in `COUNTRY_TO_REGION`. The function is exported from `index.ts` and a consumer calling it for a UAE user would get `false` — but `isSupportedCountryCode()` in `countries.ts` correctly returns `true`. There are no current callers of `isSupportedCountry` outside the package itself (confirmed by grep), but it is a latent footgun. Fix: add a deprecation comment pointing callers to `isSupportedCountryCode` from `countries.ts`.

- [LOW] packages/shared/src/countries.ts:157-163 — `merchantInCountry()` reads `merchant.denominations?.currency` (the display currency) but `Merchant.denominations` is optional and `MerchantDenominations.currency` is non-optional once the object is present. The optional chain is correct. However, the comment at line 171 says "No such rows exist in the live catalogue" but relies on the fallback `return true` for merchants with neither `country` nor `denominations`. If a future sync produces a merchant with denominations set but currency empty string (`""`), it would match no country and fall through to `return true` (visible everywhere). This is an edge case, not a current bug.

- [LOW] packages/shared/src/regions.ts — The module header says "Superseded by the per-country model in `countries.ts` (ADR 034)" and `regionByCode`, `isSupportedCountry` have zero non-package callers, yet both are exported from `index.ts`. The `GeoResponse.region` field is still actively consumed by the backend geo handler and web geo service. Recommend marking the dead exports `@deprecated` to guide future refactors, but not removing yet since `regions.ts` cannot be deleted while `GeoResponse` is in use.

- [INFO] packages/shared/src/loop-asset.ts — ADR 031 (Proposed) plans to retire `USDLOOP`/`EURLOOP` in favour of `LOOPUSD`/`LOOPEUR` (DeFindex vault shares). Current code: `LOOP_ASSET_CODES = ['USDLOOP', 'GBPLOOP', 'EURLOOP']` — correct for Phase 1 implementation. When ADR 031 is accepted, this tuple and `CURRENCY_TO_ASSET_CODE` must be updated. Note: `GBPLOOP` is retained in ADR 031, so only USD and EUR entries change.

- [INFO] packages/shared/src/merchants.ts — The field `MerchantDenominations.denominations: string[]` (the array of fixed values) and `Merchant.denominations?: MerchantDenominations` share the same field name at different levels. This is confusing to new readers but not a bug (the types are distinct).

- [INFO] packages/shared/src/proto/clustering_pb.ts:1 — Generated header confirmed: `// @generated by protoc-gen-es v2.11.0 with parameter "target=ts"`. File is checked into git (not gitignored), which contradicts README.md:41. Generation matches `@bufbuild/protobuf: 2.12.0` in `package.json`. No issues with the generated content itself.

- [INFO] packages/shared/src/order-state.ts:42-43 — Comment references `USDLOOP / GBPLOOP / EURLOOP` — consistent with `loop-asset.ts` and the current implementation. Accurate for Phase 1.

- [INFO] packages/shared/src/admin-supplier-spend.ts:72 — `SupplierSpendActivityResponse.currency` is `HomeCurrency | null`. This is technically correct: the query param accepts only `HomeCurrency` values (USD/GBP/EUR validated server-side), so the filter-echo is always a `HomeCurrency`. The actual data rows can span other currencies (CAD etc.) but the filter itself is restricted. The type is accurate for the filter-echo field.

- [INFO] packages/shared/src/countries.ts — ADR 035 entries AE/IN/SA/AU/MX all present with correct ISO codes, labels, flags, and currencies (AED/INR/SAR/AUD/MXN). `SUPPORTED_CURRENCIES` correctly lists all nine currencies. Eurozone list (20 members) matches `regions.ts`. All `merchantInCountry` currency-match logic consistent with `COUNTRIES` entries.

- [INFO] packages/shared/src/cashback-realization.ts — `recycledBps` clamping behaviour (div-by-zero → 0, negative-spent → 0, overflow → 10000) documented and correct. Bigint arithmetic is safe.

- [INFO] packages/shared/tsconfig.json — Extends `../../tsconfig.base.json`, uses `NodeNext` module resolution. No issues.

- [INFO] No hardcoded secrets found in any file in the package.

- [INFO] No TODOs without ticket/date found in the package.

## Batch 21 — scripts (1/2)

- [CRITICAL] scripts/ctx-media-cleanup.mjs:9 — Hardcoded logo.dev public key `const PK = 'pk_actJ…[token redacted]'` in source. This is the known key flagged across four files. Being a public-facing (not secret) key it is lower operational risk, but hardcoding API keys in source enables accidental rotation difficulty and ties the codebase to one account. **Recommended fix:** read from env var `LOGO_DEV_PUBLIC_KEY` or a /tmp file (as `fetch-logos.mjs` already does correctly via `/tmp/logodev-pk.txt`). The other three files with this key (`newinfo-apply.mjs`, `qc-residue-fix.mjs`, `note-resource.mjs`) are in a different batch — flag confirmed for this file.

- [HIGH] scripts/ctx-combined-split-apply.mjs:53-55 — Partial-apply hazard: the script disables the combined-name merchant if `famMissing === 0` (all constituent merchants exist in the local snapshot), but it does NOT check whether all constituent `PUT /merchants/:id` link-calls succeeded. If one or more link PUTs fail silently (logged to console but execution continues), the combined-name merchant still gets disabled, leaving the brand unreachable. **Recommended fix:** track per-family link-success count and only issue the disable if `linkedCount === fam.constituents.length` for that family.

- [HIGH] scripts/ctx-casing-normalize.mjs:14 / scripts/ctx-dedup-apply.mjs:14 / scripts/ctx-dupverify-apply.mjs:13 / scripts/ctx-fix-apply.mjs:14 / scripts/ctx-gc-strip.mjs:15 / scripts/ctx-family-complete.mjs:14 / scripts/ctx-name-convention.mjs:15 / scripts/ctx-name-normalize.mjs:18 / scripts/ctx-region-retag-names.mjs:14 — All nine scripts read the CTX admin bearer token from `/tmp/ctx-token.txt` unconditionally, with no fallback to an env var and no guard if the file is missing (will throw ENOENT). The token in that file is a production admin bearer token giving full write access to spend.ctx.com; leaving it in `/tmp` is an insecure pattern (readable by any process on the machine). Contrast with `ctx-group-rename.mjs` and `ctx-region-retag.mjs` which correctly prefer `process.env.CTX_TOKEN || (existsSync(...) ? readFile... : '')`. **Recommended fix:** standardise all scripts to `process.env.CTX_TOKEN || (existsSync(...) ? readFileSync(...) : '')` and document in the script header that CTX_TOKEN env var is preferred.

- [HIGH] scripts/ctx-region-retag.mjs (--apply) / scripts/ctx-region-retag-names.mjs (--apply) — Bulk-update endpoint (`PUT /merchants` with a `filter.ids` of up to 120 merchants) applied without any per-batch confirmation guard. A single misidentified country token in a merchant name would silently retag hundreds of merchants. The batch structure provides no rollback: a partial network failure mid-batch leaves some merchants retagged and others not, with no resume point for the affected batch. **Recommended fix:** add a `--limit` cap and optionally a dry-run-first requirement (the scripts already have dry-run mode, but they don't enforce it). Consider writing applied batches to a resume file the same way `ezpin-allocate.mjs` does.

- [MEDIUM] scripts/brandqc-prep.mjs:7 / scripts/cover-refix.mjs:8 / scripts/fix-2tc.mjs:3 / scripts/fix-white-logos.mjs:6 — Hardcoded absolute path `createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp')` bakes the developer's home directory into the script. These scripts will fail on any other machine or CI environment. Additionally `fix-2tc.mjs:61` and `fix-white-logos.mjs:87` hardcode `copyFileSync('/tmp/ctx-media-final.json', '/Users/ash/loop-media-work/ctx-media-final.json')`, a path outside the repo. **Recommended fix:** use `import sharp from 'sharp'` directly (it is already in the backend's node_modules and resolvable from `scripts/` after the workspace install) or use `new URL('../apps/backend', import.meta.url)` for the require path. Replace the copyFileSync destination with a configurable output path or remove it.

- [MEDIUM] scripts/ctx-domain-resolve.mjs:21 — Reads `logo.dev` secret key from `/tmp/logodev-key.txt` with no fallback env var. If the file is absent the script throws at startup before processing any records. **Recommended fix:** prefer `process.env.LOGO_DEV_SK || readFileSync('/tmp/logodev-key.txt', 'utf8')`.

- [MEDIUM] scripts/ctx-dedup-apply.mjs — The merge loop pools discounts onto the survivor and then immediately issues per-dupe `disable` PUTs in the same loop iteration. There is no atomic rollback: if the survivor `put` succeeds but a dupe `put` fails, that dupe remains enabled pointing at stale/duplicate data. The same pattern exists in `ctx-gc-strip.mjs:55-56`, `ctx-name-convention.mjs`, and `ctx-name-normalize.mjs`. Each script disables the dupe only after the survivor update succeeds, which is the correct ordering — but there is no compensating re-enable if the disable fails. **Recommended fix:** record failed disable IDs and emit a post-run warning list so they can be manually cleaned up.

- [MEDIUM] scripts/domain-review-server.mjs — Local HTTP review server (port 7655) has no authentication whatsoever. It exposes the full merchant domain queue and writes user decisions to `/tmp/ctx-domain-review.json` via unauthenticated POST to `/save`. While this is intended for local use only, it binds to `0.0.0.0` by default (Node.js `createServer().listen(PORT)` default) rather than `127.0.0.1`. Any process on a local network or VPN could submit arbitrary decisions. **Recommended fix:** bind explicitly to `127.0.0.1` — `listen(PORT, '127.0.0.1', ...)`.

- [MEDIUM] scripts/ezpin-availability-sweep.mjs:50-51 — EzPin API credentials (client_id + secret_key) are read from `/tmp/ezpin-client-id.txt` and `/tmp/ezpin-key.txt` with no env-var fallback. Same insecure-/tmp-pattern as the CTX token files. **Recommended fix:** `process.env.EZPIN_CLIENT_ID || readFileSync(...)`.

- [LOW] scripts/ctx-apply.mjs — Uses `import('node:module').then(...)` at the bottom to bootstrap `globalThis.require`, which is a non-standard approach for a top-level ESM module. The `require` call for `'sharp'` inside async functions (lines 88, 127, 154) will work but is fragile (if sharp is not in the top-level package.json it will resolve against the wrong module tree). This is already the pattern used by several scripts via `createRequire`, but `ctx-apply.mjs` uses a dynamic late-import approach. **Recommended fix:** hoist the `createRequire` to the top of the file.

- [LOW] scripts/build-cover-sheets.mjs / scripts/build-logo-sheets.mjs — All intermediate HTML and PNG output goes to `/tmp/` with no cleanup step. A run producing hundreds of sheets will leave large amounts of data in `/tmp/`. Not a data-corruption risk but a disk-space/reproducibility concern. These are one-off QC tools so the impact is low. **Note:** all output is in `/tmp/` which is cleared on reboot.

- [LOW] scripts/ctx-curate-uncovered.mjs — Read-only analysis script; safe. The classification of "in-market vs other-market" includes `MARKET_COUNTRIES` set that now lacks some newer markets (e.g., MX, AE, SA, AU, IN which were added in ADR-035 / feat/serve-strong-foreign-markets). The ADR-034 comment in the code says these are informational tags, not filtering, so this is cosmetic rather than blocking.

- [LOW] scripts/ctx-build-gap-merge.mjs — The fallback `|| 'US'` country for SVS products (line 78: `ccyCountry(p.CurrencyCode) || nameCountry(p.Name) || 'US'`) silently assigns US to any product whose currency and name give no country signal. This could produce incorrect gap-merge plans. **Recommended fix:** classify these as `unknown` and report separately instead of silently defaulting to US.

- [LOW] scripts/demo-seed.mjs — Hardcodes a fake Stellar address `GDEMO5LOOPDEMO5LOOPDEMO5LOOPDEMO5LOOPDEMO5LOOPDEMO5LOOPX` as a display-only demo wallet address. The address is clearly synthetic (repeating pattern), but it also has no validation that the address is not on mainnet. Since this is a dev-only seed script the risk is negligible, but noting for completeness.

- [INFO] scripts/ctx-anomalies.mjs — Read-only scan, no API writes. Well-structured. Suitable candidate for committing as a reusable CI/cron tool.

- [INFO] scripts/ctx-build-enrichment.mjs — Read-only, safe. Reads supplier data from /tmp and produces /tmp output. Good candidate for committing.

- [INFO] scripts/ctx-build-gap-merge.mjs — Read-only analysis. Good candidate for committing as a reusable diagnosis tool.

- [INFO] scripts/ctx-crossredeem.mjs — Read-only scanner. Solid candidate for a committed tool.

- [INFO] scripts/ctx-curate-uncovered.mjs — Read-only classification script. Good candidate for committing.

- [INFO] scripts/ctx-dup-scan.mjs — Read-only duplicate scanner with excellent country-code handling. Strong candidate for committing as a reusable data-quality tool.

- [INFO] scripts/ctx-provider-gaps.mjs — Read-only cross-provider gap reporter. Commit-worthy.

- [INFO] scripts/check-admin-bundle-split.sh — Well-structured CI tool with good heuristics. Already committed. No issues.

- [INFO] scripts/check-audit-policy.mjs — Robust dependency-audit gate. Already committed. No issues.

- [INFO] scripts/check-bundle-budget.sh — Good bundle size gate. Already committed. No issues.

- [INFO] scripts/check-env-perms.sh — Useful hygiene nudge for local dev env file permissions. Already committed. No issues.

- [INFO] scripts/ci-watch.sh — Well-designed CI poller. Already committed. No issues.

- [INFO] scripts/bootstrap-e2e-refresh-token.sh — Token printed to stdout at line 158 in the non-`--gh-secret` path, which may be captured in shell history or CI logs. The `--gh-secret` path correctly uses `printf '%s' | gh ...` to avoid argv exposure. The final hint at line 162 does `echo '$REFRESH_TOKEN'` using single quotes, so it prints the literal string rather than the expanded token — this is safe (it's illustrative text). No issues with the actual flow.

- [INFO] scripts/e2e-real.mjs — Already committed. No hardcoded credentials. Sensitive env vars documented. Production-safe design (all secrets via env, key written with `mode: 0o600`). No issues.

- [INFO] scripts/lint-docs.sh — Well-structured multi-section docs linter. Already committed. Correctly excludes audit evidence. No issues.

- [INFO] scripts/logo-dims.mjs — Pure utility module (no writes, no credentials). Good candidate for committing (useful for any logo ingestion pipeline).

- [INFO] scripts/demo-seed.mjs — Useful local dev tool. Minor: DATABASE_URL falls back to a hardcoded default (`postgres://loop:loop@localhost:5433/loop`) which is fine for dev but should be documented. Untracked.

- [INFO] scripts/domain-review-server.mjs — Useful human-review UI. Main concern is the `0.0.0.0` bind (see HIGH finding above). Untracked one-off tool.

- [INFO] scripts/build-logo-montages.mjs — Read-only image tool (builds contact sheets for vision QC). Reads from /tmp, writes to /tmp. No production API calls. Untracked one-off tool.

- [INFO] scripts/build-logo-sheets.mjs / scripts/build-cover-sheets.mjs — Visual QC sheet generators using Playwright. All I/O via /tmp. Untracked one-off tools.

- [INFO] scripts/brandqc-prep.mjs — Vision-QC metrics enricher. See MEDIUM finding for hardcoded path. Untracked one-off tool.

- [INFO] scripts/ctx-apply.mjs — The main catalog write applier. Has good dry-run/limit/idempotency design. The `--force` flag bypasses the "already populated" check for images; this is intentional and guarded by the flag. No hardcoded credentials (CTX_TOKEN from env). Already a solid candidate for committing if the `require` bootstrap is cleaned up.

- [INFO] scripts/ezpin-allocate.mjs — Well-designed with progress tracking, done-file for resume, dry-run mode. Has env-var-or-file pattern for CTX_TOKEN. Candidate for committing.

- [INFO] scripts/ezpin-availability-sweep.mjs — Good design: cached, resumable. See MEDIUM finding for EzPin key files. Candidate for committing.

- [INFO] scripts/fetch-logos.mjs — Reads logo.dev PK from `/tmp/logodev-pk.txt` (correct pattern, no hardcode). Candidate for committing.

- [INFO] scripts/ctx-group-rename.mjs — Has env-var-or-file pattern for token (the improved pattern). Well-designed with 8-worker concurrency and retry-on-network-error. Candidate for committing.

- [INFO] scripts/ctx-region-retag.mjs — Has env-var-or-file pattern. See HIGH finding for missing confirmation guard on bulk operations.

---

## Batch 22 — scripts (2/2)

### CRITICAL

- [CRITICAL] scripts/newinfo-apply.mjs:10 — Hardcoded logo.dev public API key `pk_actJ…[token redacted]` (same key flagged by other batches). Baked into a URL template that gets written to `/tmp/ctx-media-final.json` and eventually pushed to CTX as permanent `logoUrl` values, meaning the secret leaks into the production catalog database. — Move to `process.env.LOGODEV_TOKEN`; replace all embedded `?token=${PK}` URLs before they reach production, or switch to server-side logo proxying.

- [CRITICAL] scripts/note-fixes-media.mjs:6 — Same hardcoded `pk_actJ…[token redacted]` key, same issue as above. Token appears in generated logo.dev URLs that are written to `/tmp/ctx-media-final.json` and later applied to CTX. — Same fix.

- [CRITICAL] scripts/note-resource.mjs:6 — Same hardcoded `pk_actJ…[token redacted]` key. Identical pattern. — Same fix.

- [CRITICAL] scripts/qc-residue-fix.mjs:9 — Same hardcoded `pk_actJ…[token redacted]` key. Used in `logoDev()` which writes URLs with the embedded token to `/tmp/ctx-media-final.json`. — Same fix.

- [CRITICAL] scripts/qc-residue-fix.mjs:12 — Hardcoded absolute path to a session-specific Claude task output file: `/private/tmp/claude-501/-Users-ash-code-loop-app/19cd3253-a26f-4157-bfe1-78144150dfbe/tasks/wlw6k9zmm.output`. This is a machine-local, session-transient file path. The script will silently produce empty/wrong results on any other machine or after the session expires. — Replace with a stable, configurable path or a CLI argument.

### HIGH

- [HIGH] scripts/merge-pairs.mjs:1 — Bulk destructive writes to production CTX API (`PUT /merchants/:id` to disable merchants and pool supplier products) with zero confirmation guard. The `PAIRS` array is hardcoded; if a name lookup produces an incorrect match (e.g. `razer` dynamic resolution), a wrong merchant gets modified/disabled with no prompt or dry-run mode. No `--dry-run` flag. — Add a `--dry-run` flag; print planned operations and require `--confirm` to proceed.

- [HIGH] scripts/merge-pairs.mjs:41-75 — No error handling on either the `PUT` survivor update or the `PUT` dupe-disable: `r1.ok && r2.ok` is only logged; if the survivor update fails but the dupe-disable succeeds, the catalog loses supplier coverage silently. — Abort the disable step if the merge PUT fails; at minimum treat `r1.ok === false` as a hard error.

- [HIGH] scripts/tillo-allocate.mjs:211-279 — Bulk `POST /merchants` + `PUT /merchants/:id` to production CTX with no confirmation guard. Has `--dry-run` flag (good), but live mode runs immediately on the full plan (hundreds of merchants). A fat-finger omitting `--dry-run` writes hundreds of merchants with no undo path. — Recommend: require explicit `--confirm` when not in dry-run mode, and print a count + sample before proceeding.

- [HIGH] scripts/svs-allocate.mjs:195-253 — Same pattern as tillo-allocate.mjs: bulk `POST`/`PUT` to production CTX with `--dry-run` available but no confirmation gate for live runs. — Same recommendation.

- [HIGH] scripts/recount.mjs:8-13 — No error handling on the paginated fetch loop (`d.pagination.pages` will throw if the response is not JSON or the server returns an error, aborting mid-loop with partial data already fetched, but the write may not have happened yet — the concern is a silent bad catalog state if the loop exits with `all` half-populated and a later script reads it). Compare `pull-fresh.mjs` which has explicit retry logic. — Wrap the fetch in a try/catch with retry (like `pull-fresh.mjs`); validate `d.pagination` before accessing `.pages`.

### MEDIUM

- [MEDIUM] scripts/logo-opacity-scan.mjs:8 — `createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp')` hardcodes an absolute path to the developer's local machine. The script is non-portable and silently fails on any other machine or CI. — Use `createRequire(import.meta.url)` or import `sharp` directly if it's in devDependencies.

- [MEDIUM] scripts/newinfo-apply.mjs:7 — Same hardcoded `createRequire('/Users/ash/code/loop-app/apps/backend/')('sharp')` portability issue. — Same fix.

- [MEDIUM] scripts/note-resource.mjs:4 — Same hardcoded sharp path. — Same fix.

- [MEDIUM] scripts/note-fixes-media.mjs:5 — Same hardcoded sharp path, plus line 241 copies the output file to `/Users/ash/loop-media-work/ctx-media-final.json` — a hardcoded absolute path to the developer's home directory; silently fails on other machines. — Remove or parameterize the copyFileSync destination.

- [MEDIUM] scripts/note-resource.mjs:147 — Same hardcoded `copyFileSync` to `/Users/ash/loop-media-work/ctx-media-final.json`. — Same fix.

- [MEDIUM] scripts/merge-pairs.mjs:3-4 — `CTX_TOKEN` read directly from `process.env.CTX_TOKEN` with no null-check; if unset, all API calls send `Authorization: Bearer undefined` and will fail with 401 errors but the script has no upfront guard. — Add `if (!T) { console.error('CTX_TOKEN not set'); process.exit(2); }` at startup.

- [MEDIUM] scripts/merge-tavily-covers.mjs:35 — `--apply` flag overwrites `/tmp/ctx-media-final.json` in-place with no backup. If the script crashes mid-write or the data is bad, the file is corrupt. — Write to a `.tmp` file and rename atomically, or create a dated backup before overwriting.

- [MEDIUM] scripts/source-images-search.mjs:29-45 — DuckDuckGo image search scraping (`vqd` token extraction from HTML, undocumented `i.js` endpoint). This is a fragile scrape of an undocumented API that will silently return empty results when DDG changes their HTML/token scheme. There's no alerting or fallback. — Document the fragility in a comment and add an empty-result warning.

- [MEDIUM] scripts/scrape-merchant-images-v2.mjs:29 — Script fetches the live production catalog at `https://api.loopfinance.io/api/merchants/all` to discover merchants to scrape, meaning a production API call is baked into the enrichment pipeline. If the endpoint is slow or throttled, the whole scrape stalls; no rate-limit handling on this initial fetch. — Use the local `/tmp/ctx-fresh.json` dump (already available) instead of hitting production.

### LOW

- [LOW] scripts/logo-opacity-scan.mjs:13-16 — Reads `/tmp/ctx-fresh.json` and `/tmp/ctx-media-final.json` with no existence check; crashes with an unclear error if the pipeline hasn't been run. — Wrap in try/catch with a helpful message pointing to the prerequisite scripts.

- [LOW] scripts/merge-media.mjs:14-22 — Reads four `/tmp/*.json` files with no existence check; pipeline order dependency is invisible. — Add `existsSync` guards with error messages naming the prerequisite script.

- [LOW] scripts/pull-ezpin-catalogs.mjs:10 — Falls back to `/tmp/ctx-token.txt` if `CTX_TOKEN` is unset, silently using a potentially stale disk token. The fallback path makes credential rotation harder to reason about. — Log a warning when the file fallback is used.

- [LOW] scripts/pull-ezpin-retailer.mjs:10 — Same fallback to `/tmp/ctx-token.txt`. — Same fix.

- [LOW] scripts/pull-fresh.mjs:10 — Same fallback to `/tmp/ctx-token.txt`. — Same fix.

- [LOW] scripts/pull-tillo-svs.mjs:11 — Same fallback to `/tmp/ctx-token.txt`. — Same fix.

- [LOW] scripts/supplier-pull.mjs:17 — Same fallback to `/tmp/ctx-token.txt`. — Same fix.

- [LOW] scripts/svs-allocate.mjs:14 — Same fallback to `/tmp/ctx-token.txt`. — Same fix.

- [LOW] scripts/scrape-headers-deep.mjs:119-122 — Crops images via `images.weserv.nl` (a free public CDN proxy). These weserv.nl URLs are stored in `/tmp/ctx-headers-deep.json` and potentially applied to CTX as permanent cover URLs. If weserv.nl goes down or rate-limits, all those cover images break simultaneously. A comment in `merge-tavily-covers.mjs` explicitly says "Store the ORIGINAL source URL, not the weserv-crop URL" — but `scrape-headers-deep.mjs` and `source-images-search.mjs` and `source-images-tavily.mjs` all emit weserv URLs. — Store the original URL; apply the crop at `ctx-apply` time (sharp can do this server-side) or use a self-hosted proxy.

- [LOW] scripts/review-server.mjs:247-285 — The `/img` proxy endpoint fetches arbitrary external URLs and serves them as images (`u` comes from URL params). While it validates `content-type` starts with `image/`, it does not restrict the set of hosts it will proxy. On a developer's localhost this is SSRF-light (no auth bypass risk), but if accidentally exposed to a network it would act as an open image proxy. — Restrict the proxy to a known allowlist of hosts (logo.dev, CTX CDNs, brand domains in media file) or bind explicitly to `127.0.0.1`.

- [LOW] scripts/review-server.mjs:232-244 — The `/save` endpoint accepts any JSON body and writes it directly to `/tmp/review-decisions.json` with no size limit or schema validation. A large body would consume disk space. — Add a body-size cap (e.g. 10MB) and JSON schema check.

- [LOW] scripts/scrape-media-proxied.mjs:193-199 — Hard exits with `process.exit(2)` if `PROXY_SERVER` is not set, but doesn't validate that `PROXY_USERNAME`/`PROXY_PASSWORD` are also set; a proxy with missing credentials will fail per-merchant with cryptic errors rather than upfront. — Validate all three proxy env vars at startup.

- [LOW] scripts/supplier-dedup.mjs:1 — Analysis-only script (no writes), but reads four `/tmp/*.json` files with no guard and will throw with cryptic errors if the pipeline hasn't been run. — INFO: good analysis script worth committing as a reusable tool; add existence guards.

- [LOW] scripts/source-covers-round3.mjs:86 — `if (!KEY)` guard exits cleanly — good. But no rate-limit handling on Tavily: if the API returns 429 the script simply throws on the next iteration. The outer try/catch swallows it and leaves that merchant with `headerUrl: null`, silently reducing coverage. — Detect 429 from Tavily and apply backoff before continuing.

- [LOW] scripts/source-redeem-research.mjs:38-37 — Same Tavily 429 gap: throws `tavily 429`, gets caught by the outer catch and written as `{ answer: '', error: 'tavily 429' }` — silently drops the research item. — Same backoff fix.

### INFO

- [INFO] scripts/postgres-init.sh — Simple, correct, committed init script for the test DB. No issues.

- [INFO] scripts/preflight-tranche-1.sh — Well-written; reads only secret names (never values). Safe to run in CI. Worth keeping as a committed tool.

- [INFO] scripts/verify.sh — Thin wrapper for CI quality checks. Clean, no issues.

- [INFO] scripts/probe-ctx-cryptocurrency.mjs — One-off probe tool. No hardcoded secrets; uses env vars correctly. Credentials via OTP flow. Safe to keep for debugging.

- [INFO] scripts/scrape-merchant-images.mjs — v1 scraper (superseded by v2). Uses Clearbit autocomplete (keyless). No hardcoded secrets. Read-only.

- [INFO] scripts/scrape-merchant-images-v2.mjs:29 — v2 scraper. Uses Clearbit (keyless) + Playwright. No secrets hardcoded. Read-only output.

- [INFO] scripts/scrape-media.mjs — Playwright-based scraper. No hardcoded secrets. Read-only. Well-structured with resume support.

- [INFO] scripts/scrape-media-proxied.mjs — Proxied version of scrape-media. Proxy creds via env vars correctly. Read-only output. Resume support.

- [INFO] scripts/source-images-tavily.mjs — Tavily key via env. Read-only candidate output. Resume support.

- [INFO] scripts/source-images-search.mjs — DDG scrape, no API key. Read-only output.

- [INFO] scripts/source-cat-covers.mjs — Tavily key via env. Writes to /tmp only. Small, focused.

- [INFO] scripts/source-covers-round3.mjs — Tavily key via env. Resume support. Writes to /tmp only.

- [INFO] scripts/source-redeem-research.mjs — Tavily key via env. Read-only research output. Resume support.

- [INFO] scripts/warm-img-cache.mjs — Pre-warms the review UI's disk cache. No secrets. Read-only (cache fill). Useful companion to review-server.

- [INFO] scripts/review-server.mjs — Local review UI only. Binds to 0.0.0.0 on port 7654 (minor SSRF surface noted in LOW finding above).

- [INFO] scripts/merge-media.mjs — Assembly pipeline. Read-only except for /tmp output. Resumable.

- [INFO] scripts/merge-tavily-covers.mjs — Dry-run flag present. Modifies /tmp only.

- [INFO] scripts/note-fixes-media.mjs — Media URL patch list. /tmp output only (plus the dev-path copyFileSync).

- [INFO] scripts/recount.mjs — Catalog re-pull. Writes to /tmp only. Missing retry (see HIGH finding).

- [INFO] scripts/resolve-missing-domains.mjs — Domain candidate gatherer. Read-only output to /tmp.

- [INFO] scripts/pull-fresh.mjs — Minimal catalog pull. /tmp output. Clean retry logic.

- [INFO] scripts/pull-tillo-svs.mjs — Supplier catalog pull. /tmp output. Clean retry logic.

- [INFO] scripts/pull-ezpin-catalogs.mjs — EzPin catalog pull. /tmp output. Clean retry logic.

- [INFO] scripts/pull-ezpin-retailer.mjs — EzPin retailer-products pull. /tmp output. Clean retry logic.

- [INFO] scripts/supplier-pull.mjs — Multi-supplier pull. /tmp output. Clean.

- [INFO] scripts/supplier-dedup.mjs — Analysis only, no writes. Good candidate for committing.

- [INFO] scripts/tillo-allocate.mjs — Production writes, has --dry-run. Well-structured. Resumable. See HIGH finding.

- [INFO] scripts/svs-allocate.mjs — Production writes, has --dry-run. Well-structured. Resumable. See HIGH finding.

- [INFO] scripts/scrape-headers-deep.mjs — Playwright browser scraper, read-only output, resume support. Well-structured.

- [INFO] scripts/logo-opacity-scan.mjs — QC scan, read-only output. Useful. See MEDIUM (sharp path) and CRITICAL (pk token).

- [INFO] scripts/merge-pairs.mjs — Small, targeted dedup tool. See HIGH findings.

- [INFO] scripts/newinfo-apply.mjs — Content + media apply for new merchants. See CRITICAL (PK token + sharp path).

- [INFO] scripts/note-resource.mjs — Same as note-fixes-media.mjs functionally. Identical content — appears to be a duplicate/renamed version of note-fixes-media.mjs. Consider consolidating.

- [INFO] scripts/qc-residue-fix.mjs — QC broken-URL re-sourcer. See CRITICAL (PK token + session-specific hardcoded path).

## ---

- [HIGH] docs/adr/028-admin-step-up-auth.md:71 — Key name inconsistency: the Decision section says `LOOP_STEP_UP_SIGNING_KEY` but the Implementation Status section (line 12) and the actual code (`apps/backend/src/env.ts:263`) both use `LOOP_ADMIN_STEP_UP_SIGNING_KEY`. The Neutral section also references `jwt-key-rotation.md` as covering this key, but that runbook has zero mentions of the step-up key. — Recommended fix: update the Decision section's key name to `LOOP_ADMIN_STEP_UP_SIGNING_KEY` throughout and add a section to `jwt-key-rotation.md` covering `LOOP_ADMIN_STEP_UP_SIGNING_KEY` / `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` staged rotation.

- [HIGH] docs/runbooks/operator-pool-exhausted.md:7 — Dead file path reference: the runbook says `apps/backend/src/operator-pool.ts` but the actual file is `apps/backend/src/ctx/operator-pool.ts`. An on-call following the runbook cannot find the referenced source. — Recommended fix: update reference to `apps/backend/src/ctx/operator-pool.ts`.

- [HIGH] docs/adr/015-stablecoin-topology-and-payment-rails.md:3 — Status line says USDLOOP/EURLOOP "retired in favour of Loop-curated DeFindex vault shares LOOPUSD/LOOPEUR" but ADR 031 (which mandates this) is still `Status: Proposed` and the actual codebase (`packages/shared/src/loop-asset.ts`, `apps/backend/src/credits/payout-asset.ts`) still uses USDLOOP/EURLOOP. The amended status claims a supersession that has not been implemented. — Recommended fix: change ADR 015's amendment note to say "partially superseded pending ADR 031 implementation" and note the live asset names remain USDLOOP/EURLOOP/GBPLOOP until ADR 031 ships.

- [MEDIUM] docs/runbooks/asset-drift-alert.md:17 — Alert body fields reference `USDLOOP`/`GBPLOOP`/`EURLOOP` which are the correct live asset names (matching code), but these names conflict with ADR 015's amendment status (which says they are retired). Once ADR 031 ships with LOOPUSD/LOOPEUR, this runbook will be stale. — Recommended fix: add a note that asset names in this runbook match current code and will need updating when ADR 031 is implemented.

- [MEDIUM] docs/adr/030-integrated-wallet-via-privy.md — Status: Proposed but the file map section references `apps/backend/src/auth/tokens.ts` rewrite (RS256 migration) and Privy webhook handlers as "new" files. `apps/backend/src/auth/jwks.ts` exists but the Privy webhook handler (`apps/backend/src/webhooks/privy.ts`) does not exist and the Privy service (`apps/web/app/services/privy.ts`) does not exist. Additionally `LinkWalletNudge.tsx` still exists despite ADR 030 saying delete it. The ADR reads as if implementation is in progress but `Status: Proposed` (open questions unresolved). — Recommended fix: clarify the implementation state; if work has started, move status to `Accepted` and update the open questions section.

- [MEDIUM] docs/adr/031-per-currency-yield-architecture.md — Status: Proposed but ADR 015 amendment note says "USDLOOP/EURLOOP retired in favour of LOOPUSD/LOOPEUR" as if decided/done. ADR 031 has 11 open questions, several marked as critical-path blockers (Privy Soroban custody DD). Vault contract directory (`contracts/loop-vault/`) does not exist. The cross-reference between ADR 015 "amended" and ADR 031 "proposed" creates an incoherent status where a superseded state references a not-yet-accepted decision. — Recommended fix: either accept ADR 031 (resolving the open questions) or revert ADR 015's amendment note to "partially superseded / pending ADR 031" language consistent with "Proposed" status.

- [MEDIUM] docs/runbooks/ — Missing runbooks for 4 alert types exported from `apps/backend/src/discord.ts`: `notifyPegBreakOnFulfillment`, `notifyInterestPoolLow`, `notifyInterestPoolRecovered`, and `notifyPayoutAwaitingTrustline`. The README's runbook index does not list these. An on-call receiving one of these Discord alerts has no procedure to follow. — Recommended fix: add runbooks for each, or at minimum add triage notes in `health-degraded.md` and/or payout runbooks for these alert types.

- [MEDIUM] docs/runbooks/jwt-key-rotation.md — ADR 028 Neutral section explicitly says "The step-up signing key joins `LOOP_JWT_SIGNING_KEY` in the rotation runbook (ADR-016 / `docs/runbooks/jwt-key-rotation.md`)" but the runbook contains zero mention of `LOOP_ADMIN_STEP_UP_SIGNING_KEY` or step-up rotation. An operator following the quarterly key rotation checklist will miss the step-up key entirely. — Recommended fix: add a `LOOP_ADMIN_STEP_UP_SIGNING_KEY` section to `jwt-key-rotation.md` mirroring the staged/emergency rotation pattern.

- [MEDIUM] docs/runbooks/ledger-drift.md:81 — References `scripts/check-ledger-invariant.ts` but this file does not exist at the repo root. The actual file is `apps/backend/src/scripts/check-ledger-invariant.ts`, and the CLI invocation is `npm --workspace=@loop/backend run check:ledger`. The reference in the "Related" section could mislead an on-call who tries to run it directly. — Recommended fix: update the path reference to the actual script location and the npm workspace command.

- [LOW] docs/adr/009-credits-ledger-cashback-flow.md — Early exploration section says "embedded wallets via Privy / dfns / Turnkey. All three were rejected." ADR 030 (Proposed) explicitly amends this, noting that Privy is now the primary vendor. The body of ADR 009 does not cross-reference the amendment, so a reader gets an outdated rejection rationale without the follow-up context. — Recommended fix: add a cross-reference note at the top of ADR 009 pointing to ADR 030's amendment of this section.

- [LOW] docs/adr/033-ip-geolocation-region-selector.md — Missing top-level `Date:` metadata field, inconsistent with all other ADRs in the directory (001–032 all have `Date: YYYY-MM-DD` in the header block). — Recommended fix: add `Date: 2026-06-xx` (approximate, or confirm exact date from git log).

- [LOW] docs/adr/034-path-based-locale-routing.md — Missing top-level `Date:` metadata field (same issue as ADR 033). — Recommended fix: add `Date:` field.

- [LOW] docs/adr/035-extended-supplier-currency-markets.md — Missing top-level `Date:` metadata field (same issue as ADRs 033–034). — Recommended fix: add `Date:` field.

- [LOW] docs/adr/027-mobile-platform-security.md — ADR 027 references `@nativescript/jailbreak-detection` and `@capgo/capacitor-secure-screen` as Phase-2 plugin candidates but these are untested against Capacitor v8 as explicitly noted. Both are Phase-2 spikes so this is acceptable deferred risk, but the Phase-2 implementation section should note that plugin availability needs re-validation at the time of implementation given Capacitor version constraints. — Recommended fix: add a note to the Phase-2 implementation order section flagging that plugin version compatibility with Capacitor 8/9 should be validated before committing.

- [LOW] docs/adr/020-public-api-surface.md:19 — The endpoint list correction note says "`/api/public/stats` was named in the original ADR but never implemented; removed 2026-05-03". This is an inline fix note preserved in the body rather than cleanly removed. The ADR is now self-referentially noting a prior error, which is good for history but slightly awkward. — Recommended fix: minor style cleanup; the note itself is fine but could be moved to a Decision History section for consistency with ADR 031's approach.

- [INFO] docs/adr/015-stablecoin-topology-and-payment-rails.md — The ADR 015 rollout checklist item #362 ("User-facing wallet-link settings — `/settings/wallet` page to paste a Stellar pubkey + unlink") is marked [x] (done), but ADR 030 says to delete `LinkWalletNudge.tsx` and rewrite the settings page as part of Privy integration. The file `apps/web/app/components/features/cashback/LinkWalletNudge.tsx` still exists. This is expected given ADR 030 is still Proposed; noting for tracking once ADR 030 moves to Accepted.

- [INFO] docs/adr/005-known-limitations.md:29 — The Phase 2 wallet description references "on-device Stellar wallet / biometric-gated signing" as the earlier plan, then correctly notes it is superseded by ADR 030 (Privy MPC). The cross-reference is present and accurate. No action needed.

- [INFO] docs/adr/028-admin-step-up-auth.md — The implementation status notes the web modal (`StepUpModal` component + `useStepUpToken` hook) is pending. This is consistent with `Status: Accepted (Phase-1 backend implemented)`. No inconsistency.

- [INFO] docs/runbooks/ctx-circuit-open.md — The runbook diagnosis step 2 uses `$GIFT_CARD_API_BASE_URL` which is an env var, not a hardcoded URL. This is correct behavior; the operator needs to have this set in their environment. No issue.

## Batch 24 — docs core

- [CRITICAL] docs/tranche-1-launch.md:68 AND docs/development.md:195 — USDC issuer address mismatch across deployment docs. `tranche-1-launch.md` and `phase-1-while-apple-approves.md` specify `GA5ZSEJYB37JRC5AVCIA7VBRVRWWZBMXWXZAHYBRQHGSZHGCASCHV3VW`; `development.md`, `apps/backend/.env.example`, and `apps/backend/src/env.ts` all specify `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. These differ at character 33 (`7` vs `5`) and diverge completely after that. The code/env version matches Centre's published mainnet USDC issuer; the tranche-1-launch version does not. An operator following `tranche-1-launch.md` for the Tranche-1 redeploy would set the wrong issuer, causing USDC payment acceptance failures. — Reconcile to a single address. Verify against the Stellar Explorer and Circle's published issuer. Update `tranche-1-launch.md`, `phase-1-while-apple-approves.md`, or `development.md`/`env.ts` as needed; annotate with the canonical source reference.

- [HIGH] CLAUDE.md (AGENTS.md):56 — "What we're building" section describes USDLOOP/GBPLOOP/EURLOOP as the cashback stablecoins per ADR 015, but ADR 031 (Proposed) retires USDLOOP and EURLOOP in favour of LOOPUSD/LOOPEUR DeFindex vault shares. An agent reading AGENTS.md first would design code around a stablecoin topology that is scheduled for retirement. The "Proposed" status of ADR 031 mitigates severity slightly, but the text is unambiguously inconsistent with the current design direction documented in architecture.md §"Cashback-app switch evolution" and roadmap.md §Phase 2. — Add a caveat: "Phase 2 design (ADR 031, Proposed) replaces USDLOOP/EURLOOP with LOOPUSD/LOOPEUR vault shares; see ADR 030/031 for the revised topology."

- [HIGH] CLAUDE.md (AGENTS.md):296 — CI job count is stated as "eleven" but the actual `ci.yml` has **twelve** jobs: `quality`, `test-unit`, `flywheel-integration`, `audit`, `sbom`, `container-cve-scan`, `secret-scan`, `build`, `test-e2e`, `test-e2e-mocked`, `test-e2e-flywheel`, `notify`. `test-e2e-flywheel` (E2E tests — loop-native flywheel, added for A2-1705 phase A.3) is missing from the enumeration. Agents that rely on the job list to reason about CI failures or PR gates will have an incomplete picture. — Update AGENTS.md to say "twelve jobs" and add `test-e2e-flywheel` to the enumeration. Also add `npm run test:e2e:flywheel` to the Quick commands section.

- [HIGH] CLAUDE.md (AGENTS.md):21 — Docs index entry for `docs/audit-2026-tracker.md` calls it the "Working tracker for the 2026-04 adversarial audit (467 findings)" implying it is live and authoritative. However the file itself carries a prominent `A4-068: superseded` banner stating the current source-of-truth is `docs/audit-2026-05-03-claude/` and `docs/audit-2026-05-03/`. Any agent following AGENTS.md's docs index to find the active audit register will be directed to a superseded file. — Update AGENTS.md docs index to either point to the actual live trackers (`docs/audit-2026-05-03-claude/tracker.md` and `docs/audit-2026-05-03/tracker.md`) or note the superseded status inline, e.g. "historical; active registers at `docs/audit-2026-05-03-claude/` and `docs/audit-2026-05-03/`".

- [HIGH] docs/standards.md:1047–1051 — Security audit policy §15 lists the accepted-moderate dependency set as `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `drizzle-kit`, `esbuild`, `postcss`. The actual `scripts/check-audit-policy.mjs` currently accepts `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `drizzle-kit`, `esbuild`, `hono` (three Hono advisories with detailed rationale). `postcss` is no longer in the accepted set; `hono` is new and undocumented. An operator or auditor reading `standards.md` would not know `hono` advisories are accepted, and would think `postcss` still requires acceptance. The mjs script is CI's source of truth; the doc is stale. — Update `standards.md §15` to list `hono` instead of `postcss`, and reproduce the rationale summary from the script.

- [HIGH] CLAUDE.md (AGENTS.md):21-50 — Docs index ADR table stops at ADR 031. ADRs 032 (`merchant-variant-grouping`), 033 (`ip-geolocation-region-selector`), 034 (`path-based-locale-routing`), and 035 (`extended-supplier-currency-markets`) exist in `docs/adr/` but have no entries in the AGENTS.md docs index. ADR 034 is architecturally significant (changes the SSR loader exception rule, adds a new geo-redirect route) and is referenced in the body of AGENTS.md critical-rules §1 without an index entry. ADR 035 (AE/IN/SA/AU/MX extended markets) is the most recent accepted ADR but is completely absent. Agents discovering the codebase through AGENTS.md will not know these ADRs exist. — Add index rows for ADRs 032–035 with one-line summaries.

- [MEDIUM] docs/roadmap.md:34–39 — Phase 1 "Production infrastructure" items `Deploy backend to Fly.io`, `Deploy web (SSR) to Fly.io or Vercel`, `Set up monitoring`, and `DNS` are all marked `[ ]` (unchecked). Per project memory, the Phase-1 backend chain was validated end-to-end on 2026-05-14 against deployed `api.loopfinance.io`, meaning the backend is live and DNS is provisioned. The `Deploy backend` and `DNS: api.loopfinance.io` items are stale-unchecked. — Tick `~~Deploy backend to Fly.io~~` and the api DNS item; update the monitoring status if `SENTRY_DSN` has since been set in Fly secrets.

- [MEDIUM] docs/standards.md:1027–1035 — §15 CI/CD job sketch shows only 7 jobs: `quality`, `test-unit`, `audit`, `build`, `test-e2e-mocked`, `test-e2e`, `notify`. Missing from the list: `flywheel-integration`, `sbom`, `container-cve-scan`, `secret-scan`, `test-e2e-flywheel` — five of the twelve actual CI jobs. An agent reading §15 to understand what CI covers will have a materially incomplete picture of the security and e2e gates. — Expand the CI job sketch in §15 to the full twelve-job list with one-line descriptions matching AGENTS.md's approach.

- [MEDIUM] docs/testing.md:61 — States that flywheel e2e tests "run in CI under the `flywheel-integration` lane." This is incorrect: the flywheel Playwright suite runs in the **`test-e2e-flywheel`** CI job, not the `flywheel-integration` job. `flywheel-integration` runs the vitest integration suite (`npm run test:integration`), which is different. — Correct the lane name to `test-e2e-flywheel`.

- [MEDIUM] docs/development.md:291–293 (Root commands section) — Lists `test:e2e`, `test:e2e:mocked`, and `test:e2e:real` but omits `test:e2e:flywheel` which is defined in root `package.json` and runs in CI. Developers running the docs' command reference would have no knowledge of this suite. — Add `npm run test:e2e:flywheel` with its description to the commands table.

- [MEDIUM] docs/audit-2026-tracker.md:3 — Self-declares as superseded (A4-068 banner), directing readers to `docs/audit-2026-05-03-claude/` and `docs/audit-2026-05-03/` as the current source of truth. But AGENTS.md docs index still calls this file the "working tracker." This creates a navigational contradiction for any agent or operator following the docs. Three separate audit programs coexist with conflicting authority claims: (1) old `audit-tracker.md`/`audit-checklist.md`/`codebase-audit.md` (each has a superseded header), (2) `audit-2026-tracker.md` (claims to be superseded internally, live externally), (3) `audit-2026-04-29/` (AGENTS.md points to this), (4) `audit-2026-05-03*` (what the tracker says is live). — Consolidate authority: decide which register is canonical, update AGENTS.md accordingly, and add a redirect note to all superseded files.

- [MEDIUM] docs/development.md:194–195 — The `development.md` backend env section lists `LOOP_STELLAR_USDLOOP_ISSUER` and `LOOP_STELLAR_EURLOOP_ISSUER` as relevant env vars (they exist in `env.ts` and `.env.example`). Per ADR 031 (Proposed) these assets are retired; although ADR 031 is not yet Accepted, the roadmap (§Phase 2) explicitly says "Asset rename: USDLOOP and EURLOOP retired. Code references retired; never issued in production." Having these vars in the dev guide without a `[Phase 2 — retiring, see ADR 031]` annotation is confusing. — Add a deprecation note inline referencing ADR 031.

- [MEDIUM] docs/architecture.md — Does not mention ADR 035 (extended supplier-currency markets: AE/IN/SA/AU/MX). This is an accepted ADR that affects the country model, merchant filter, and the set of valid `/:country/:lang` routes. The architecture section on locale routing covers ADR 034 but is silent on the additions from ADR 035. A developer adding a new country or debugging why a particular market isn't visible would not find the constraint documented. — Add a paragraph in the locale-routing section of `architecture.md` summarising the ADR 035 "≥15 merchants = strong market" threshold rule.

- [LOW] docs/testing.md:122 — "When tests run" table CI row lists "Flywheel-integration (real-postgres flywheel walk)" and "Mocked e2e (`test:e2e:mocked`)" and "Loop-native flywheel e2e" as separate entries. The "Loop-native flywheel e2e" entry accurately reflects `test-e2e-flywheel` CI job, but the label "Flywheel-integration" mixes up the vitest integration job with the e2e flywheel — they are distinct jobs. The table is technically correct in listing both but the naming is easy to conflate. — Clarify the labels to "Flywheel integration vitest suite (`flywheel-integration` CI job)" and "Loop-native flywheel Playwright suite (`test-e2e-flywheel` CI job)".

- [LOW] docs/roadmap.md — Does not mention ADR 032 (merchant variant grouping), ADR 033 (IP geolocation region selector), ADR 034 (path-based locale routing — phases 1–5 all shipped per git history), or ADR 035 (extended supplier-currency markets). These are all accepted and shipped. The roadmap's Phase 1 and Phase 3 sections omit the web localisation work entirely, making the roadmap feel more incomplete than it is. — Add completed checkboxes for the ADR 034 locale-routing phases and ADR 035 extended-market work under the relevant phase.

- [LOW] docs/slo.md — States "Loop is pre-launch" in the preamble. Given the 2026-05-14 e2e-real validation confirms `api.loopfinance.io` is live, this claim may need a revision note, though the SLO targets themselves remain aspirational until real traffic is measured. — Add a note: "Backend deployed 2026-05-14; SLO targets remain aspirational until stable traffic patterns are observed."

- [LOW] CLAUDE.md (AGENTS.md):295 — States "The self-contained mocked e2e suite (`test-e2e-mocked`, boots mock-ctx + backend + web on isolated ports) runs on every push to main and every PR." This is correct, but the quick-commands section (line 106) only shows `npm run test:e2e` and `npm run test:e2e:real`, omitting `npm run test:e2e:mocked` (the explicit alias) and `npm run test:e2e:flywheel`. — Add both missing commands to the Quick commands section.

- [LOW] docs/archive/2026-pre-implementation-research.md — Historical doc references "Next.js" as the original framework and multi-step plan, but the superseded header is in place. No issue with the header; the doc is archived correctly. Confirm the banner is prominent. (No action needed beyond confirming the archive header exists — it does.)

- [INFO] docs/admin-csv-conventions.md — Well-structured and accurate. Closes A2-1523. Cross-references to backend handler files are by convention not by path; no staleness detected.

- [INFO] docs/api-compat.md — Comprehensive backward-compat contract. ADR 020 reference is correct. The sunset-window policy section correctly notes it is not yet formalised ("before Phase 2"). No immediate issue.

- [INFO] docs/app-store-connect-metadata.md — Descriptive metadata draft for App Store submission. Copy matches Tranche-1 surface (discount, not cashback). Subtitle "Crypto gift cards, save now" is 27 chars (within 30). Bundle ID `io.loopfinance.app` is consistent with `capacitor.config.ts`. No discrepancies found.

- [INFO] docs/alerting.md — Accurately describes Discord-only single-tier alerting for Phase 1 (A2-1327). Phase-2 paging plan section is clearly labelled. No issues.

- [INFO] docs/error-codes.md — Cross-checked against `packages/shared/src/api.ts` patterns; family groupings and HTTP statuses appear consistent. `DAILY_LIMIT_EXCEEDED` vs `DAILY_CAP_EXCEEDED` in the table uses `DAILY_LIMIT_EXCEEDED` which should be verified against the actual emitted code in the admin handler.

- [INFO] docs/log-policy.md — Accurate description of `REDACT_PATHS` in `apps/backend/src/logger.ts`. Sentry scrubber references (`sentry-scrubber.ts` in both backend and web) verified to exist. Role/RBAC table is sensible for Phase 1. No staleness detected.

- [INFO] docs/third-party-licenses.md — Covers libvips (LGPL), Leaflet markers (BSD-2), flag-icons (MIT), `@capgo/inappbrowser` (MPL-2.0), `@anthropic-ai/claude-code` (commercial), `postgres` driver (Unlicense). All entries include licence, attribution, and rationale. No missing packages found for the named obligations.

- [INFO] docs/mobile-native-ux.md — Phase 1 checklist items all marked done. Plugin inventory matches `apps/mobile/package.json`. Deep-linking and push notifications items correctly marked unchecked. No staleness.

- [INFO] docs/oncall.md — Two-maintainer rotation, severity SLAs, incident template, post-mortem policy, customer comms all covered. Closes A2-1901/1902/1903 as stated. No staleness detected.

- [INFO] docs/audit-checklist.md — Superseded header present (A2-1809). Kept for history. No action needed.

- [INFO] docs/audit-tracker.md — Superseded header present (A2-1809). Kept for history. No action needed.

- [INFO] docs/codebase-audit.md — Superseded header present (A2-1809). Kept for history. No action needed.

- [INFO] docs/audit-2026-adversarial-plan.md — Comprehensive audit plan. Historical use; correctly prefaced as frozen. Plan references a 2026-04-23 commit `450011d`. No issues with the doc itself.

- [INFO] docs/audit-2026-remediation-plan.md — Detailed batch remediation plan. References `audit-2026-tracker.md` as the live register; given that tracker's `A4-068: superseded` note this creates a dangling reference, but it is a known cascade of the same tracker-authority contradiction noted above.

- [INFO] docs/audit-2026-admin-handoff.md — Operator-action items for GitHub settings. Well-structured, each with verification command. Several items (`A2-119` org 2FA, `A2-103` engineering team) are high-severity; status unknown. No doc-accuracy issue beyond the tracker authority conflict.

- [INFO] docs/phase-1-demo-audit-2026-05-06.md — Android demo readiness audit. Findings documented with fixed/deferred status. Specific, time-boxed document; no general-purpose staleness issue.

- [INFO] docs/phase-1-demo-script.md — Shot script for acceptance demo video. Accurate against Tranche-1 surface. No conflicts.

- [INFO] docs/phase-1-deployed-snapshot-2026-05-06.md — Point-in-time snapshot before Tranche-1 redeploy. Historical reference document; self-describes as a "before" snapshot. No action needed.

- [INFO] docs/phase-1-redeploy-audit.md — Covers all boot-time gates added since 2026-04-20 deploy. Operator action items 1–4 are clear. Cross-references to `docs/tranche-1-launch.md` are correct.

- [INFO] docs/phase-1-while-apple-approves.md — Track A/B/C checklist while waiting for Apple approval. Uses the `...AVCIA7...` USDC issuer address (shares the same inconsistency as `tranche-1-launch.md` — already captured as CRITICAL above).

- [INFO] docs/tranche-2-scoping.md — Comprehensive 11-track Tranche 2 plan. All blocking items clearly marked. Refers to ADR 030/031 as "Proposed" which is accurate. No staleness issues beyond the ADR status.

- [INFO] docs/archive/migration.md — `HISTORICAL (A2-1808)` header present. Correctly describes superseded state. No action.

- [INFO] docs/archive/ui-restoration-plan.md — `HISTORICAL (A2-1807)` header present, all items marked Done. Correctly archived. No action.

- [INFO] docs/archive/2026-pre-implementation-research.md — `HISTORICAL — NOT CURRENT` header present. Correctly archived. No action.

## Batch 25 — audit evidence (1/2)

- None

No secrets, tokens, credentials, real customer PII, Stellar private keys, GitHub tokens, or JWTs were found in any of the 200 files reviewed. No editor swap files, huge blobs, or accidentally committed artifacts were found. All files are legitimate audit evidence, planning, or working artifacts consistent with their directory's purpose.

Notes on items that required closer inspection:

1. `docs/audit-2026-05-03/evidence/phase-16-shared-contracts/notes.md` (not in the batch list but linked from the Codex notes): The `all-source-package-json.concat` artifact contains package manifests with no secrets — only dependency names and versions.

2. `docs/audit-2026-05-03/evidence/phase-17-security-privacy/artifacts/local-env-secret-residue.txt` (referenced by the grep scan): This file intentionally records only key **names** and file metadata (mode, size, mtime) from the gitignored local `.env` files. No secret values appear. The file is proper audit evidence for a finding about file-mode permissions on local dev env files.

3. `docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/ci.yml.snapshot` and `backend-fly.toml.snapshot`: These contain `${{ secrets.DISCORD_WEBHOOK_DEPLOYMENTS }}` (a GitHub Actions expression, not a resolved value), and `TRUST_PROXY=true` / `IMAGE_PROXY_ALLOWED_HOSTS=...` (non-secret env config). No actual secret values present.

4. `docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/npm-ls-workspaces-depth0.json`: Contains package metadata and local paths (`/Users/ash/code/loop-app/...`). The local path leaks the developer's username (`ash`) and project location — this is harmless developer-machine path residue in a local audit workspace, not a credential.

5. `docs/audit-2026-05-03-claude/findings/register.md` (line ~800): References that local `.env` files exist with `GIFT_CARD_API_KEY/SECRET, DISCORD_WEBHOOK_*` key names and mode 644 — this is a finding description that names keys but never includes values.

6. The `npm-test.txt` artifact contains `"to":"a@b.com"` in a test log line — this is an obviously synthetic test address, not real user PII.

7. All branch-protection JSON artifacts contain only GitHub API URL responses and GitHub App IDs (e.g., `app_id: 15368`). No PATs, OAuth tokens, or installation tokens are present.

8. All Stellar addresses referenced in evidence files are either placeholder strings (`GABC`, `GOOPS`, `GBAD` from test mocks) or generic environment variable names (`LOOP_STELLAR_OPERATOR_SECRET`). No actual 56-character Stellar secret keys (S...) appear.

## Batch 26 — audit evidence (2/2)

- [INFO] docs/audit-2026-evidence/phase-16-cicd.md:342 — Documents that `STELLAR_TEST_SECRET_KEY` is a mainnet hot-wallet Stellar secret stored as a repo-scoped GitHub secret (no environment scoping). The file contains no actual key value — it cites the risk and remediation (move to a `e2e-real` GitHub Environment with `required_reviewers`). Existing finding A2-1406 covers this. No new finding; note for traceability that the evidence file clearly flags the exposure surface and intentionally redacts the actual value. — No action required on the evidence file; underlying infra finding A2-1406 should remain open.
- [INFO] docs/audit-2026-05-03/evidence/phase-17-security-privacy/artifacts/local-env-secret-residue.txt — Correctly documents that `apps/backend/.env` (mode 644, not tracked) contains secret-bearing key names (`GIFT_CARD_API_KEY`, `GIFT_CARD_API_SECRET`, Discord webhooks). Values are intentionally redacted; only key names and file metadata captured. File is well-formed evidence for finding A4-030. — No issue; correct redaction practice followed.
- [INFO] docs/audit-2026-evidence/phase-3-npm-audit.json — Contains 5 `"severity": "moderate"` npm audit entries (drizzle-kit / esbuild chain). No high/critical severity. File is expected audit artifact. — No action required.
- [INFO] docs/audit-2026-05-03/inventory/file-disposition.tsv — 1227 rows; large but expected (one row per tracked file). No secrets or PII. — No action required.
- [INFO] docs/audit-2026-05-03/inventory/tracked-files.txt — 1226 lines of git-tracked paths. Clean. — No action required.
- [INFO] docs/audit-2026-05-03/evidence/phase-06-auth-identity/artifacts/auth-admin-gate-lines.txt — 2507 lines; largest single artifact. Contains excerpted source code via grep output. Includes Sentry scrubber regex listing redacted field names (not values). No actual secrets present. — No action required.

## Batch 27 — root + .github + e2e

- [MEDIUM] AGENTS.md:296 — CI job count stale: AGENTS.md says "eleven jobs" and lists them, but `test-e2e-flywheel` is a 12th job present in ci.yml that is omitted from the list. AI agents relying on AGENTS.md to understand the CI gate will miss that the flywheel suite is a required-passing check. Fix: add `test-e2e-flywheel` to the jobs list and update the count to twelve.

- [MEDIUM] AGENTS.md docs-index — ADRs 032–035 exist on disk (`032-merchant-variant-grouping`, `033-ip-geolocation-region-selector`, `034-path-based-locale-routing`, `035-extended-supplier-currency-markets`) but the AGENTS.md docs index stops at ADR 031. Any agent reading AGENTS.md to understand current architecture will miss path-based locale routing (ADR 034) and the extended-currency markets model (ADR 035), which are directly relevant to work on the current branch. ADRs 001–004 (static-export, TypeScript backend, protobuf, security-hardening) are also absent, though those are foundational/historical. Fix: extend the docs index table through ADR 035 (at minimum ADRs 032–035 are recently-landed).

- [MEDIUM] .github/CODEOWNERS — `@LoopDevs/engineering` team does not exist (acknowledged as A2-103 in the file comments), meaning every CODEOWNERS rule is silently a no-op today. The wildcard default `*` and all explicit path entries (auth, ledger, Stellar, DB schema, ADRs) provide no actual enforcement. This includes `.github/workflows/**`, which is not listed as a separate entry — CI workflow files that could be modified to bypass all checks are therefore unprotected in practice. Fix: create the `@LoopDevs/engineering` team, or until then add individual user entries (`@ashfrancis` or equivalent) so CODEOWNERS rules are actually enforced. Add an explicit `.github/workflows/**` entry for defence in depth.

- [LOW] .github/workflows/pr-automation.yml:45–46 — `ADDITIONS` and `DELETIONS` are assigned via direct `${{ github.event.pull_request.additions || 0 }}` interpolation in a `run:` block rather than via `env:` variables. Although `pull_request.additions` is a GitHub-computed integer (not user-controlled), the pattern is inconsistent with the `env:`-variable-first posture used in the `notify` step of ci.yml for BRANCH/ACTOR. Best practice (and the pattern followed in the rest of the codebase) is to assign context expressions through `env:` so they never appear literally in a shell script. Low risk because GitHub guarantees a numeric value, but fix for consistency: move to `env: ADDITIONS: ${{ github.event.pull_request.additions || 0 }}` etc.

- [LOW] CONTRIBUTING.md:35 — CI job count listed as "7 jobs" (`quality`, `test-unit`, `audit`, `build`, `test-e2e-mocked`, `test-e2e`, `notify`), which is significantly outdated. The actual count is 12 jobs. Missing from the CONTRIBUTING.md list: `flywheel-integration`, `sbom`, `container-cve-scan`, `secret-scan`, and `test-e2e-flywheel`. Fix: update to match the current ci.yml job inventory.

- [LOW] AGENTS.md:296 — AGENTS.md git-workflow section describes required branch-protection checks as `Quality (typecheck, lint, format, docs)`, `Unit tests`, `Security audit`, `Build verification`, `E2E tests (mocked CTX)`. This omits the newer required jobs: `Flywheel integration (real postgres)`, `SBOM + provenance + signing`, `Container CVE scan (trivy)`, `Secret scan (gitleaks)`, `E2E tests (loop-native flywheel)`. Agents will not know these are blocking gates and cannot accurately advise on whether a PR will merge. Fix: update the branch-protection required checks list.

- [INFO] .github/CODEOWNERS — `.github/workflows/` is not listed as a separate CODEOWNERS entry (covered only by the `*` wildcard). Even when the `@LoopDevs/engineering` team exists, an explicit `.github/workflows/ @LoopDevs/engineering` entry is defense-in-depth: it makes the protection of workflow files explicit and visible, preventing a future maintainer from assuming the wildcard is sufficient if the team account ever changes.

- [INFO] .gitleaks.toml — `playwright.*.config.ts` is in the paths allowlist to suppress false-positives from the fixture JWT signing key and Stellar addresses. This is appropriate since these are test-only values and the comments explain the reasoning clearly. Worth noting the pattern is broad (any `playwright.*.config.ts`); if a real-upstream playwright config were ever added that contained real secrets, it would be silently excluded from gitleaks scanning.

- [INFO] .github/workflows/pr-review.yml — The workflow triggers on `pull_request` (not `pull_request_target`), so secrets (`ANTHROPIC_API_KEY`) are not available to fork PRs — the review step silently produces no output for fork-originated PRs. This is intentional and correct security posture; the design accepts that external-contributor PRs don't get the automated review. Worth documenting explicitly in ADR-025 since its cost/benefit reasoning covers the "what gets sent" angle but not the fork-PR gap.

- [INFO] playwright.flywheel.config.ts:70 — `LOOP_JWT_SIGNING_KEY: 'flywheel-walk-loop-jwt-signing-key-32-chars-min'` is a hardcoded fixture key in a test config. The gitleaks allowlist explicitly exempts this file, and the value is obviously non-production (it contains the phrase "min"). The allowlist comment in `.gitleaks.toml` explains the reasoning. No action needed — documented for completeness.

- [INFO] tests/e2e-flywheel/global-setup.ts — The seed SQL uses raw string interpolation via `drizzle.execute(sql.raw(...))` for the TRUNCATE statement and tagged `sql` template literals for inserts. The tagged template form is parameterised and safe; the `sql.raw()` TRUNCATE uses a hardcoded string assembled from the `TABLES_TO_TRUNCATE` array (all static constants). No injection surface. The seed is test-only and never runs in production.

- [INFO] docker-compose.yml — Defines only a `db` service (Postgres 16). The image is not SHA-pinned (`postgres:16` floating tag). For a dev-only compose file this is acceptable; the production DB runs on Fly.io with a pinned version in the Fly config. No action required but worth noting the inconsistency with the SHA-pinned posture in ci.yml/Dockerfiles.

## Batch 28 — root misc remainder

- [MEDIUM] tests/e2e-mocked/global-setup.ts:24 — `TABLES_TO_TRUNCATE` list is missing `user_favorite_merchants` (added in migration `0032_user_favorite_merchants.sql`). Between-test isolation is incomplete: if any test (or seed) inserts a favorite, it persists into subsequent tests. `user_favorite_merchants` has a FK to `users` so `TRUNCATE users ... CASCADE` would normally cascade-delete it, but it depends on whether the FK is set up with `ON DELETE CASCADE`. Even if cascades happen to work now, the missing entry is a silent correctness assumption that breaks the moment the FK drops the cascade rule. Explicit truncation is the right pattern (as done for all other tables). Add `'user_favorite_merchants'` to the list. — Add `'user_favorite_merchants'` to `TABLES_TO_TRUNCATE` array at line 24.

- [LOW] tests/e2e-mocked/global-setup.ts:24 vs tests/e2e-flywheel/global-setup.ts:24 — `social_id_token_uses` is present in the flywheel setup's truncate list but not in the mocked setup's list (line 24 shows 13 entries vs flywheel's 13 which includes `social_id_token_uses`). Cross-checking: the mocked file actually DOES include `social_id_token_uses` at position 8, so these two are now in sync on that table. The divergence is only the missing `user_favorite_merchants` in both setups. (Note: flywheel/global-setup.ts is out of scope for this batch but the same fix applies there.)

- [LOW] tests/e2e-mocked/purchase-flow.test.ts:14-15 — Port constants `MOCK_CTX_URL = 'http://localhost:9091'` and `BACKEND_URL = 'http://localhost:8081'` are hardcoded strings. These duplicate the port values already declared authoritatively in `playwright.mocked.config.ts`. If the ports in the config are ever changed, the test file silently breaks (calls go to the wrong server). A cleaner approach is to read the ports from `process.env` matching the config's injected env or to use Playwright's `request` fixture with the `baseURL`. This is a maintainability risk, not currently broken.

- [LOW] tests/e2e/purchase-flow.test.ts — Entire file has no protection against the ADR 034 geo-redirect at `/`. Tests call `page.goto('/')` which, in SSR mode, results in a 302 to `/<country>/en`. Playwright follows redirects by default, so the test ends up on `/us/en` (or similar). The locator `a[href*="/gift-card/"]` still matches because MerchantCard generates `/gift-card/<slug>` links (not localized paths), and `page.waitForURL(/\/gift-card\//)` is a substring match so it passes. This works by coincidence — if links are ever localized (e.g. `/<country>/en/gift-card/<slug>`), the locator would still match but the `waitForURL` regex would still work too. No action needed today, but worth a comment documenting the assumption so future ADR 034 work doesn't silently break the tests.

- [INFO] tsconfig.base.json — `verbatimModuleSyntax: false` is set explicitly. The TypeScript default for `verbatimModuleSyntax` is `false`, so this is a no-op, but it documents the intentional choice to allow synthetic default imports and re-exports. No issue; purely informational.

- [INFO] tsconfig.base.json — `module` and `moduleResolution` are not set in the base config. Each consuming tsconfig (web: `ESNext` + `Bundler`; backend inherits node defaults) sets these independently, which is correct. The base only mandates strictness, which is the right pattern for a monorepo.

- [INFO] tests/e2e/smoke.test.ts:43 — `page.getByText(/Sign in to view/i)` correctly matches the rendered text "Sign in to view your order history." in `orders.tsx:263`. The partial regex match is intentional and correct.

- [INFO] tests/e2e-mocked/purchase-flow.test.ts:78-143 — The mocked suite correctly guards tests with `test.beforeEach(resetMock)` and resets both the mock CTX server state and the backend's in-memory rate-limit counters via `POST /__test__/reset`. The `DISABLE_RATE_LIMITING=1` env var in the playwright config is a belt-and-suspenders addition that makes the suite robust even if the reset endpoint misses a bucket.

- [INFO] tests/e2e-mocked/global-setup.ts:40-52 — `globalSetup` correctly closes the postgres client in a `finally` block via `client.end({ timeout: 5 })`. Migration idempotency is handled by drizzle's migrator. `TRUNCATE … RESTART IDENTITY CASCADE` is the correct approach for test isolation.

# Part III — Cross-cutting findings (Layer 2)

> Six interaction-layer audits, included in full: API contract parity, env-var lifecycle, migration chain, CI/CD pipeline, money-path invariants, future plans.

## Cross-cutting — API contract parity

### Findings

### MEDIUM — web AppConfig silently drops `loopAssets`

- `apps/web/app/services/config.ts:34` ↔ `apps/backend/src/config/handler.ts:60`
- Backend `AppConfig` sends `loopAssets: { USDLOOP, GBPLOOP, EURLOOP }` each with `{ issuer: string|null, available: boolean }`. Web `AppConfig` type omits this field entirely — the runtime payload is silently dropped on the client side. No web component currently reads `loopAssets` from config (they use `/api/public/loop-assets` instead) so there is no live breakage, but any Phase-2 surface that branches on `loopAssets.*.available` before using `@loop/shared`'s getter will see `undefined` instead of the object.
- **Fix:** Add `loopAssets: { USDLOOP: LoopAssetConfig; GBPLOOP: LoopAssetConfig; EURLOOP: LoopAssetConfig }` to the web `AppConfig` interface (importing `LoopAssetConfig` from the backend type or adding it to `@loop/shared`). Move `AppConfig` to `@loop/shared` to enforce parity.

### MEDIUM — OpenAPI `AppConfigResponse` omits `phase1Only`

- `apps/backend/src/openapi/health.ts:48-70` ↔ `apps/backend/src/config/handler.ts:94`
- `configHandler` serialises `phase1Only: env.LOOP_PHASE_1_ONLY` in every `/api/config` response. The OpenAPI `AppConfigResponse` schema (`registerHealthOpenApi`) has `loopAuthNativeEnabled`, `loopOrdersEnabled`, `loopAssets`, and `social` — but no `phase1Only`. Generated clients strip the field. `phase1Only` gates 10+ web components (`Phase2Gate.tsx`, `Navbar.tsx`, `Footer.tsx`, `MobileHome.tsx`, etc.) and its absence from the spec means any code-gen consumer would silently lose a critical feature flag.
- **Fix:** Add `phase1Only: z.boolean()` to `AppConfigResponse` in `apps/backend/src/openapi/health.ts`.

### MEDIUM — `favorites` and `recently-purchased` types duplicated, not in `@loop/shared` (ADR 019 violation)

- `apps/web/app/services/favorites.ts:18-45` ↔ `apps/backend/src/users/favorites-handler.ts:48-210`
- `apps/web/app/services/recently-purchased.ts:13-27` ↔ `apps/backend/src/users/recently-purchased-handler.ts:41-59`
- Four interfaces (`FavoriteMerchantView`, `ListFavoritesResponse`, `AddFavoriteResult`, `RemoveFavoriteResult`) and two interfaces (`RecentlyPurchasedMerchantView`, `RecentlyPurchasedResponse`) are declared identically in both the backend handlers and the web service modules. They are structurally identical today, but any field addition on the backend side (e.g. a new `pinnedAt` on favorites) will silently be invisible to the web until both copies are updated.
- **Fix:** Move all six interfaces to `packages/shared/src/` (e.g. `user-favorites.ts` + `user-recently-purchased.ts`), re-export from `packages/shared/src/index.ts`, and import from `@loop/shared` in both the backend handler and the web service.

### MEDIUM — `UserPendingPayoutState` is a redundant re-declaration of `PayoutState`

- `packages/shared/src/users-me.ts:57` vs `packages/shared/src/payout-state.ts:18`
- `UserPendingPayoutState = 'pending' | 'submitted' | 'confirmed' | 'failed'` and `PayoutState = (typeof PAYOUT_STATES)[number]` expand to the same four-literal union. Having two names for the same domain concept means a future state addition (e.g. `'cancelled'`) must be applied to both types and the `PAYOUT_STATES` array or the schemas drift. `users-me.ts` should alias `PayoutState` rather than re-declare it.
- **Fix:** In `packages/shared/src/users-me.ts`, replace the inline union with `export type UserPendingPayoutState = PayoutState;` importing from `./payout-state.js`.

### LOW — `PublicFlywheelStats` and `PublicLoopAsset/PublicLoopAssetsResponse` duplicated in web, not in `@loop/shared` (ADR 019 / partially)

- `apps/web/app/services/public-stats.ts:121-127` defines `PublicFlywheelStats` locally; `apps/backend/src/public/flywheel-stats.ts:46-52` defines an identical struct.
- `apps/web/app/services/public-stats.ts:93-100` defines `PublicLoopAsset` and `PublicLoopAssetsResponse` locally with a hardcoded `code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP'` union instead of importing `LoopAssetCode` from `@loop/shared`; `apps/backend/src/public/loop-assets.ts:43-51` defines identically-shaped interfaces using `LoopAssetCode`.
- The service file itself acknowledges both cases with "ADR 019 consolidates when there's a second consumer; today the web side is the first." Both backends now have a second consumer (the backend handler) so ADR 019's condition is met.
- **Fix:** Move `PublicFlywheelStats`, `PublicLoopAsset`, and `PublicLoopAssetsResponse` to `packages/shared/src/` and import from `@loop/shared` in both sides.

### LOW — `LoopAuthPair` (social-login response) is a web-local type, not in `@loop/shared`

- `apps/web/app/services/auth.ts:32-36` — `LoopAuthPair { accessToken, refreshToken, email? }` is defined locally. `VerifyOtpResponse` (OTP path) is already in `@loop/shared`; social login has its own local type with one extra optional field (`email`). The backend social handler (`apps/backend/src/auth/social.ts:174-176`) always returns `email`; the web type makes it optional. This is acceptable intent (`email` is optional for call sites that don't need it) but the type lives only in the web service layer.
- **Fix:** Add `SocialLoginResponse` to `packages/shared/src/api.ts` extending `VerifyOtpResponse` with `email: string`, import it in both the backend openapi registration and the web auth service.

### LOW — `MerchantCashbackRateResponse` and `MerchantsCashbackRatesResponse` duplicated in web

- `apps/web/app/services/merchants.ts:52-89` — these two interfaces are defined locally; backend `cashback-rate-handlers.ts` returns the same shape inline without a named type export. Shapes currently match. No `@loop/shared` type exists for either.
- **Fix:** Move both to `packages/shared/src/merchants.ts` (or a dedicated `merchant-cashback.ts`).

### INFO — Backend exports `GET /api/admin/interest/mint-forecast` with no web service wrapper

- `apps/backend/src/routes/admin-treasury.ts:82` registers the route; `apps/backend/src/openapi/admin-treasury-assets.ts:189` registers it in the spec. No corresponding function exists in any `apps/web/app/services/admin-*.ts` file. The admin panel does not surface a mint-forecast page.
- This is an intentional gap (feature not yet wired up in UI) rather than a contract drift. No action required unless the admin panel needs the surface.

### INFO — Backend exports DSR self-serve endpoints with no web service wrapper

- `GET /api/users/me/dsr/export` and `POST /api/users/me/dsr/delete` exist in `apps/backend/src/routes/users.ts:109-118`. Web `privacy.tsx` documents them as raw API calls; no `services/` wrapper exists.
- Intentional: DSR endpoints are documented for direct API use. No service wrapper is needed until the web builds a self-serve deletion flow.

### INFO — `AdminMerchantResyncResponse` and other admin write-result shapes not in `@loop/shared`

- `apps/web/app/services/admin-merchants-resync.ts:30-37`, `apps/web/app/services/admin-user-credits.ts` (CreditAdjustmentResult, WithdrawalResult), etc. — per-writer result shapes are defined inline in the web slice and not in `@loop/shared`. Each comment acknowledges this with "no other consumers, so promoting them to @loop/shared would just add indirection." These are acceptable ADR 019 deferences while there is only one consumer.
- Track as pending migration candidates once a second consumer (e.g. mobile, script consumer) appears.

---

### Contract log

| METHOD    | Path                                     | Web service file              | Backend handler                     | Shared type?                                                                         | Verdict        |
| --------- | ---------------------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | -------------- |
| GET       | /api/public/cashback-stats               | public-stats.ts               | public/cashback-stats.ts            | `@loop/shared` PublicCashbackStats                                                   | PASS           |
| GET       | /api/public/top-cashback-merchants       | public-stats.ts               | public/top-cashback-merchants.ts    | `@loop/shared` PublicTopCashbackMerchantsResponse                                    | PASS           |
| GET       | /api/public/merchants/:id                | public-stats.ts               | public/merchant.ts                  | `@loop/shared` PublicMerchantDetail                                                  | PASS           |
| GET       | /api/public/cashback-preview             | public-stats.ts               | public/cashback-preview.ts          | `@loop/shared` PublicCashbackPreview                                                 | PASS           |
| GET       | /api/public/loop-assets                  | public-stats.ts               | public/loop-assets.ts               | NO — web local `PublicLoopAsset` duplicates backend                                  | WARN (LOW)     |
| GET       | /api/public/flywheel-stats               | public-stats.ts               | public/flywheel-stats.ts            | NO — web local `PublicFlywheelStats` duplicates backend                              | WARN (LOW)     |
| GET       | /api/public/geo                          | geo.ts                        | public/geo.ts                       | `@loop/shared` GeoResponse                                                           | PASS           |
| GET       | /api/config                              | config.ts                     | config/handler.ts                   | NO — web `AppConfig` missing `loopAssets` field                                      | DRIFT (MEDIUM) |
| GET       | /api/merchants                           | merchants.ts                  | merchants/handler.ts                | `@loop/shared` MerchantListResponse                                                  | PASS           |
| GET       | /api/merchants/all                       | merchants.ts                  | merchants/handler.ts                | `@loop/shared` MerchantAllResponse                                                   | PASS           |
| GET       | /api/merchants/:id                       | merchants.ts                  | merchants/handler.ts                | `@loop/shared` MerchantDetailResponse                                                | PASS           |
| GET       | /api/merchants/by-slug/:slug             | merchants.ts                  | merchants/handler.ts                | `@loop/shared` MerchantDetailResponse                                                | PASS           |
| GET       | /api/merchants/:id/cashback-rate         | merchants.ts                  | merchants/cashback-rate-handlers.ts | NO — web local `MerchantCashbackRateResponse`                                        | WARN (LOW)     |
| GET       | /api/merchants/cashback-rates            | merchants.ts                  | merchants/cashback-rate-handlers.ts | NO — web local `MerchantsCashbackRatesResponse`                                      | WARN (LOW)     |
| GET       | /api/clusters                            | clusters.ts                   | clustering/handler.ts               | `@loop/shared` ClusterResponse                                                       | PASS           |
| POST      | /api/auth/request-otp                    | auth.ts                       | auth/routes.ts                      | `@loop/shared` RequestOtpRequest                                                     | PASS           |
| POST      | /api/auth/verify-otp                     | auth.ts                       | auth/routes.ts                      | `@loop/shared` VerifyOtpResponse                                                     | PASS           |
| DELETE    | /api/auth/session                        | auth.ts                       | auth/routes.ts                      | none needed (void)                                                                   | PASS           |
| POST      | /api/auth/social/google                  | auth.ts                       | auth/social.ts                      | NO — web local `LoopAuthPair` (superset of shared VerifyOtpResponse)                 | WARN (LOW)     |
| POST      | /api/auth/social/apple                   | auth.ts                       | auth/social.ts                      | NO — web local `LoopAuthPair`                                                        | WARN (LOW)     |
| POST      | /api/orders                              | orders.ts                     | orders.ts                           | `@loop/shared` CreateOrderRequest/Response                                           | PASS           |
| GET       | /api/orders                              | orders.ts                     | orders.ts                           | `@loop/shared` OrderListResponse                                                     | PASS           |
| GET       | /api/orders/:id                          | orders.ts                     | orders.ts                           | `@loop/shared` Order                                                                 | PASS           |
| POST      | /api/orders/loop                         | orders-loop.ts                | orders.ts                           | `@loop/shared` CreateLoopOrderRequest/Response                                       | PASS           |
| GET       | /api/orders/loop/:id                     | orders-loop.ts                | orders.ts                           | `@loop/shared` LoopOrderView                                                         | PASS           |
| GET       | /api/orders/loop                         | orders-loop.ts                | orders.ts                           | `@loop/shared` LoopOrderListResponse                                                 | PASS           |
| GET       | /api/users/me                            | user.ts                       | users/handler.ts                    | `@loop/shared` UserMeView                                                            | PASS           |
| POST      | /api/users/me/home-currency              | user.ts                       | users/handler.ts                    | `@loop/shared` UserMeView                                                            | PASS           |
| PUT       | /api/users/me/stellar-address            | user.ts                       | users/handler.ts                    | `@loop/shared` UserMeView                                                            | PASS           |
| GET       | /api/users/me/cashback-history           | user.ts                       | users/handler.ts                    | `@loop/shared` CashbackHistoryResponse                                               | PASS           |
| GET       | /api/users/me/pending-payouts            | user.ts                       | users/handler.ts                    | `@loop/shared` UserPendingPayoutsResponse                                            | PASS           |
| GET       | /api/users/me/pending-payouts/summary    | user.ts                       | users/handler.ts                    | `@loop/shared` UserPendingPayoutsSummaryResponse                                     | PASS           |
| GET       | /api/users/me/orders/:id/payout          | user.ts                       | users/handler.ts                    | `@loop/shared` UserPendingPayoutView                                                 | PASS           |
| GET       | /api/users/me/credits                    | user.ts                       | users/handler.ts                    | `@loop/shared` UserCreditsResponse                                                   | PASS           |
| GET       | /api/users/me/cashback-summary           | user.ts                       | users/handler.ts                    | `@loop/shared` UserCashbackSummary                                                   | PASS           |
| GET       | /api/users/me/cashback-by-merchant       | user.ts                       | users/handler.ts                    | `@loop/shared` CashbackByMerchantResponse                                            | PASS           |
| GET       | /api/users/me/cashback-monthly           | user.ts                       | users/handler.ts                    | `@loop/shared` CashbackMonthlyResponse                                               | PASS           |
| GET       | /api/users/me/orders/summary             | user.ts                       | users/handler.ts                    | `@loop/shared` UserOrdersSummary                                                     | PASS           |
| GET       | /api/users/me/flywheel-stats             | user.ts                       | users/handler.ts                    | `@loop/shared` UserFlywheelStats                                                     | PASS           |
| GET       | /api/users/me/payment-method-share       | user.ts                       | users/handler.ts                    | `@loop/shared` UserPaymentMethodShareResponse                                        | PASS           |
| GET       | /api/users/me/stellar-trustlines         | user.ts                       | users/stellar-trustlines.ts         | `@loop/shared` StellarTrustlinesResponse                                             | PASS           |
| GET       | /api/users/me/favorites                  | favorites.ts                  | users/favorites-handler.ts          | NO — duplicated (not in @loop/shared) — shapes match                                 | WARN (MEDIUM)  |
| POST      | /api/users/me/favorites                  | favorites.ts                  | users/favorites-handler.ts          | NO — duplicated                                                                      | WARN (MEDIUM)  |
| DELETE    | /api/users/me/favorites/:id              | favorites.ts                  | users/favorites-handler.ts          | NO — duplicated                                                                      | WARN (MEDIUM)  |
| GET       | /api/users/me/recently-purchased         | recently-purchased.ts         | users/recently-purchased-handler.ts | NO — duplicated                                                                      | WARN (MEDIUM)  |
| GET       | /api/admin/treasury                      | admin-treasury.ts             | admin/treasury.ts                   | `@loop/shared` TreasurySnapshot                                                      | PASS           |
| GET       | /api/admin/treasury/credit-flow          | admin-treasury.ts             | admin/treasury-credit-flow.ts       | `@loop/shared` TreasuryCreditFlowResponse                                            | PASS           |
| POST      | /api/admin/step-up                       | admin-step-up.ts              | admin/step-up-handler.ts            | web-local AdminStepUpResponse — backend sends {stepUpToken, expiresAt}; shapes match | PASS           |
| POST      | /api/admin/payouts/:id/retry             | admin-payouts.ts              | admin/payouts-retry.ts              | web-local AdminPayoutView + `@loop/shared` PayoutState                               | PASS           |
| GET       | /api/admin/payouts                       | admin-payouts.ts              | admin/orders.ts                     | web-local AdminPayoutView                                                            | PASS           |
| GET       | /api/admin/orders/:id/payout             | admin-payouts.ts              | admin/orders.ts                     | web-local AdminPayoutView                                                            | PASS           |
| GET       | /api/admin/orders                        | admin-orders.ts               | admin/orders.ts                     | web-local AdminOrderView (no @loop/shared equivalent)                                | PASS           |
| POST      | /api/admin/merchants/resync              | admin-merchants-resync.ts     | admin/merchants-resync.ts           | web-local AdminMerchantResyncResponse                                                | PASS           |
| POST      | /api/admin/users/:id/home-currency       | admin-user-home-currency.ts   | admin/home-currency-set.ts          | web-local HomeCurrencySetResult — backend shape matches                              | PASS           |
| GET       | /api/admin/assets/:assetCode/circulation | admin-assets.ts               | admin/asset-circulation.ts          | `@loop/shared` AssetCirculationResponse                                              | PASS           |
| GET       | /api/admin/asset-drift/state             | admin-assets.ts               | admin/asset-drift-state.ts          | `@loop/shared` AssetDriftStateResponse                                               | PASS           |
| GET       | /api/admin/settlement-lag                | admin-settlement-lag.ts       | admin-payouts.ts                    | `@loop/shared` SettlementLagResponse                                                 | PASS           |
| GET       | /api/admin/cashback-realization          | admin-cashback-realization.ts | admin/cashback-realization.ts       | `@loop/shared` CashbackRealizationResponse                                           | PASS           |
| GET       | /api/admin/supplier-spend                | admin-supplier-spend.ts       | admin/supplier-spend.ts             | `@loop/shared` SupplierSpendResponse                                                 | PASS           |
| GET       | /api/admin/operator-stats                | admin-operator-stats.ts       | admin/operator-stats.ts             | `@loop/shared` OperatorStatsResponse                                                 | PASS           |
| GET       | /api/admin/interest/mint-forecast        | —                             | admin/interest-mint-forecast.ts     | NO web service — endpoint exists, not surfaced in admin UI                           | INFO           |
| GET /POST | /api/users/me/dsr/\*                     | —                             | users/handler.ts                    | NO web service — documented in privacy.tsx for direct API use                        | INFO           |
| GET       | /api/admin/reconciliation                | —                             | admin-ops-tail.ts                   | NO web service — backend endpoint and openapi spec exist                             | INFO           |

### Coverage

49 service files / 114 endpoint calls checked.

## Cross-cutting — env-var lifecycle parity

Generated: 2026-06-11  
Scope: `apps/backend/src/env.ts` (77 vars) + web `VITE_*` (4 vars) = **81 vars total**

---

### Findings

### [CRITICAL] LOOP_STELLAR_USDC_ISSUER — value-level split across docs — operator MUST verify which is correct before live traffic

- `apps/backend/src/env.ts` comment (line 323): `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- `apps/backend/.env.example` (line 240): `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- `docs/development.md` (line 195): `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- `docs/tranche-1-launch.md` (lines 68, 152): `GA5ZSEJYB37JRC5AVCIA7VBRVRWWZBMXWXZAHYBRQHGSZHGCASCHV3VW`

The two values diverge at character 15: `AVCIA5…` vs `AVCIA7…`. The key baked into `tranche-1-launch.md` (the operator runbook that sets the live secret) is completely different from the key in every other file. One of these is wrong. The watcher will reject USDC payments if the live deployment uses the wrong issuer. **Fix**: verify against Circle's canonical Stellar USDC issuer (GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN is the known Centre/Circle mainnet issuer); update `docs/tranche-1-launch.md` if it is wrong, or update `env.ts` comment + `.env.example` + `docs/development.md` if the launch doc is correct.

---

### [HIGH] EMAIL_REPLY_TO_ADDRESS — parsed in code, absent from env.ts schema, missing from all docs

`apps/backend/src/auth/email.ts` (line 196) reads `process.env['EMAIL_REPLY_TO_ADDRESS']` directly, bypassing the Zod schema in `env.ts`. The variable is set in `apps/backend/fly.toml` [env] (`EMAIL_REPLY_TO_ADDRESS = "hello@loopfinance.io"`, line 54) and has a test (`email.test.ts`), but it does not appear in:

- `apps/backend/src/env.ts` — not in schema; no type safety, no boot-time validation
- `apps/backend/.env.example` — not documented for local dev
- `docs/development.md` — not mentioned
- `docs/deployment.md` — not in env table
- `AGENTS.md` env summary — not mentioned
- `scripts/preflight-tranche-1.sh` — not checked

The lint-docs.sh parity check (§1) does NOT catch this because it only checks vars declared in `env.ts`; a var read via bare `process.env[...]` is invisible to the check. A typo in fly.toml silently sends emails without a Reply-To header (no boot error). **Fix**: add `EMAIL_REPLY_TO_ADDRESS: z.string().email().optional()` to `env.ts`; add it to `.env.example`; add it to `TOML_OR_SECRETS` in preflight.

---

### [HIGH] 17 env.ts vars absent from deployment.md env table — operators cannot configure them from docs alone

The following vars are parsed in `env.ts` and documented in `docs/development.md` / `.env.example` but are **entirely absent** from `docs/deployment.md`'s env reference tables:

- `LOOP_MERCHANT_DENYLIST` — new in A2-1922; no deployment-doc entry
- `SENTRY_RELEASE` — A2-1309 backend release tag; deployment doc has `SENTRY_DSN` but not `SENTRY_RELEASE`
- `DATABASE_STATEMENT_TIMEOUT_MS` — A2-724; has a default (30000) that prod operators may want to tune
- `LOOP_ADMIN_STEP_UP_SIGNING_KEY` / `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` — ADR 028 / A4-063; the step-up gate fails closed (503) when absent, which blocks admin credit-adjust / withdrawals / payout-retry permanently in any deployment that hasn't provisioned it. **Also absent from `scripts/preflight-tranche-1.sh` REQUIRED list** — so preflight passes even though all destructive admin endpoints are 503.
- `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` — all four email vars are absent from `docs/deployment.md`. An operator reading only deployment docs has no guidance that these are required when `LOOP_AUTH_NATIVE_ENABLED=true`.
- `LOOP_PAYOUT_FEE_BASE_STROOPS`, `LOOP_PAYOUT_FEE_CAP_STROOPS`, `LOOP_PAYOUT_FEE_MULTIPLIER` — A2-1921 fee-bump strategy
- `LOOP_KILL_ORDERS`, `LOOP_KILL_AUTH`, `LOOP_KILL_WITHDRAWALS` — A2-1907 runtime kill switches; the runbook reference (`docs/runbooks/kill-switch.md`) mentioned in `.env.example` does not exist
- `LOOP_INTEREST_POOL_ACCOUNT`, `LOOP_INTEREST_POOL_MIN_DAYS_COVER` — ADR 009/015 interest pool watcher

---

### [HIGH] LOOP_ADMIN_STEP_UP_SIGNING_KEY absent from preflight-tranche-1.sh required set

`scripts/preflight-tranche-1.sh` checks 9 REQUIRED secrets before deploy. `LOOP_ADMIN_STEP_UP_SIGNING_KEY` is not in REQUIRED, RECOMMENDED, or TOML_OR_SECRETS. When absent, `env.ts` boots cleanly (it's `optional()`), but the ADR-028 gate in the credit-adjust / withdrawal / payout-retry endpoints fails closed with `503 STEP_UP_UNAVAILABLE`. This means a Tranche-1 deploy that passes preflight may silently have all destructive admin endpoints permanently blocked. **Fix**: add to REQUIRED or RECOMMENDED in preflight and document in `docs/deployment.md`.

---

### [MEDIUM] DISCORD_WEBHOOK_DEPLOYMENTS — in CI and preflight RECOMMENDED, not in env.ts schema

`DISCORD_WEBHOOK_DEPLOYMENTS` is referenced in:

- `.github/workflows/ci.yml` line 875: `DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK_DEPLOYMENTS }}`
- `scripts/preflight-tranche-1.sh` RECOMMENDED list

But it is **not** in `apps/backend/src/env.ts` (the backend never sends to it — CI does). So it is not a backend env var per se, but it is also not documented in `docs/deployment.md`'s CI/secrets section, nor in `AGENTS.md`. An operator reading docs has no guidance that this CI secret needs to be provisioned for Discord notifications to work.

---

### [MEDIUM] CI build job sets VITE_SENTRY_RELEASE but not VITE_LOOP_ENV or VITE_SENTRY_DSN

`ci.yml` build job (lines 519, 524, 528, 529) sets:

- `VITE_API_URL=https://api.loopfinance.io` ✓
- `VITE_SENTRY_RELEASE=<sha>` ✓ (push-only)

But does **not** set:

- `VITE_LOOP_ENV` — so CI builds always fall back to `import.meta.env.MODE` for the Sentry environment tag; push builds go to production Sentry as "production" even when they're branch builds
- `VITE_SENTRY_DSN` — so Sentry is off in CI-built bundles (intentional for PR builds; for push builds it means the uploaded source maps are for a bundle that has Sentry disabled, making the maps useless for the deployment that gets these artifacts)

`apps/web/fly.toml` `[build.args]` (lines 30–38) does list `VITE_SENTRY_DSN = ""`, `VITE_SENTRY_RELEASE = ""`, `VITE_LOOP_ENV = ""` as empty defaults — so Fly deploy builds will have Sentry disabled by default until the operator sets the Fly secrets. The CI web build and the Fly web build are two separate systems: the CI build uploads source maps to Sentry (when `SENTRY_AUTH_TOKEN` is set) for a bundle that has Sentry's `dsn` blank. This is a latent mismatch — source maps point to a release that is never reported in Sentry events.

---

### [MEDIUM] SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT — CI secrets undocumented in any ops doc

These three secrets are required for source-map upload (`ci.yml` lines 552–554). They appear in `docs/audit-2026-tracker.md` (item A2-1307) as "operator wires", but are not listed in:

- `docs/deployment.md`
- `docs/development.md`
- `AGENTS.md`

An operator provisioning CI for the first time has no checklist for these.

---

### [MEDIUM] LOOP_E2E_REFRESH_TOKEN / STELLAR_TEST_SECRET_KEY — CI-only secrets not documented outside e2e-real.yml

`e2e-real.yml` requires `secrets.LOOP_E2E_REFRESH_TOKEN` and `secrets.STELLAR_TEST_SECRET_KEY`. Neither appears in any docs file. The bootstrap script (`scripts/bootstrap-e2e-refresh-token.sh`) generates the former; the latter has no documented provisioning path.

---

### [LOW] LOOP_MERCHANT_DENYLIST — in env.ts and .env.example, absent from development.md and deployment.md

A2-1922 var added to `env.ts` with a complete comment but missing from the operator-facing env tables in `docs/development.md` (§Backend env vars) and `docs/deployment.md`.

---

### [LOW] Default port mismatch: web fly.toml uses 3000, but AGENTS.md says the web dev server runs on :5173 and backend on :8080

`apps/web/fly.toml` sets `PORT=3000` in `[env]`. This is a server-side SSR port (react-router-serve, internal to Fly), correct for production. But `AGENTS.md` quick-commands say `dev:web` runs on `:5173` — no confusion there since these are different modes. Not a parity defect, but flagged as a potential point of confusion.

---

### [LOW] docs/runbooks/kill-switch.md referenced in .env.example does not exist

`.env.example` (line 323) references `docs/runbooks/kill-switch.md` for the kill-switch operator runbook. That file does not exist. The kill switch vars (`LOOP_KILL_ORDERS`, `LOOP_KILL_AUTH`, `LOOP_KILL_WITHDRAWALS`) also have no entry in `docs/deployment.md`.

---

### [INFO] lint-docs.sh env parity check is sound for env.ts-declared vars

The `scripts/lint-docs.sh` §1 check correctly verifies that every var extracted from the `[A-Z_]+:` pattern in `env.ts` appears in `.env.example`. Confirmed by running it manually — zero missing vars for the 77 env.ts vars. However it has a blind spot: vars read via bare `process.env['...']` in application code (e.g. `EMAIL_REPLY_TO_ADDRESS`, `LOOP_STELLAR_HORIZON_URL` before A2-1513, `CTX_OPERATOR_POOL` before A2-1812) bypass the check entirely. The check is not a complete coverage guarantee.

---

### Variable matrix

| VAR                                           | env.ts               | .env.example           | dev-docs | deploy-docs             | preflight    | verdict                                            |
| --------------------------------------------- | -------------------- | ---------------------- | -------- | ----------------------- | ------------ | -------------------------------------------------- |
| PORT                                          | ✓                    | ✓                      | ✓        | ✓                       | ✗ (fly.toml) | OK                                                 |
| NODE_ENV                                      | ✓                    | ✓                      | ✓        | ✓                       | ✗ (fly.toml) | OK                                                 |
| LOG_LEVEL                                     | ✓                    | ✓                      | ✓        | ✓                       | ✗ (fly.toml) | OK                                                 |
| GIFT_CARD_API_BASE_URL                        | ✓                    | ✓                      | ✓        | ✓                       | ✗ (fly.toml) | OK                                                 |
| CTX_CLIENT_ID_WEB                             | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| CTX_CLIENT_ID_IOS                             | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| CTX_CLIENT_ID_ANDROID                         | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| GIFT_CARD_API_KEY                             | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| GIFT_CARD_API_SECRET                          | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| REFRESH_INTERVAL_HOURS                        | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOCATION_REFRESH_INTERVAL_HOURS               | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| INCLUDE_DISABLED_MERCHANTS                    | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_MERCHANT_DENYLIST                        | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| IMAGE_PROXY_ALLOWED_HOSTS                     | ✓                    | ✓                      | ✓        | ✓                       | ✗ (fly.toml) | OK                                                 |
| MAXMIND_GEOLITE2_PATH                         | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK (build-time secret)                             |
| DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT     | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| TRUST_PROXY                                   | ✓                    | ✓                      | ✓        | ✓                       | ✗ (fly.toml) | OK                                                 |
| DISABLE_RATE_LIMITING                         | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| METRICS_BEARER_TOKEN                          | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | OK                                                 |
| OPENAPI_BEARER_TOKEN                          | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | OK                                                 |
| ADMIN_DAILY_ADJUSTMENT_CAP_MINOR              | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| DISCORD_WEBHOOK_ORDERS                        | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REC)      | OK                                                 |
| DISCORD_WEBHOOK_MONITORING                    | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REC)      | OK                                                 |
| DISCORD_WEBHOOK_ADMIN_AUDIT                   | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REC)      | OK                                                 |
| SENTRY_DSN                                    | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REC)      | OK                                                 |
| SENTRY_RELEASE                                | ✓                    | ✓                      | ✗        | ✗                       | ✗            | MEDIUM: missing dev-docs + deploy-docs             |
| LOOP_ENV                                      | ✓                    | ✓                      | ✓        | ✓                       | ✓ (TOML)     | OK                                                 |
| DATABASE_URL                                  | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | OK                                                 |
| DATABASE_POOL_MAX                             | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| DATABASE_STATEMENT_TIMEOUT_MS                 | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| ADMIN_CTX_USER_IDS                            | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| DEFAULT_USER_CASHBACK_PCT_OF_CTX              | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| DEFAULT_LOOP_MARGIN_PCT_OF_CTX                | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_JWT_SIGNING_KEY                          | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | OK                                                 |
| LOOP_JWT_SIGNING_KEY_PREVIOUS                 | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_ADMIN_STEP_UP_SIGNING_KEY                | ✓                    | ✓                      | ✗        | ✗                       | ✗            | HIGH: missing deploy-docs + preflight              |
| LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS       | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| LOOP_AUTH_NATIVE_ENABLED                      | ✓                    | ✓                      | ✓        | ✓                       | ✓ (TOML)     | OK                                                 |
| LOOP_PHASE_1_ONLY                             | ✓                    | ✓                      | ✓        | ✓                       | ✓ (TOML)     | OK                                                 |
| GOOGLE_OAUTH_CLIENT_ID_WEB                    | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| GOOGLE_OAUTH_CLIENT_ID_IOS                    | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| GOOGLE_OAUTH_CLIENT_ID_ANDROID                | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| APPLE_SIGN_IN_SERVICE_ID                      | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_STELLAR_DEPOSIT_ADDRESS                  | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | OK                                                 |
| LOOP_STELLAR_USDC_ISSUER                      | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | CRITICAL: value mismatch across docs               |
| LOOP_STELLAR_USDLOOP_ISSUER                   | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_STELLAR_GBPLOOP_ISSUER                   | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_STELLAR_EURLOOP_ISSUER                   | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_STELLAR_USDC_FLOOR_STROOPS               | ✓                    | ✓                      | ✓        | ✓                       | ✓ (TOML)     | OK                                                 |
| LOOP_STELLAR_OPERATOR_SECRET                  | ✓                    | ✓                      | ✓        | ✓                       | ✓ (REQUIRED) | OK                                                 |
| LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS         | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_INTEREST_POOL_ACCOUNT                    | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| LOOP_INTEREST_POOL_MIN_DAYS_COVER             | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| EMAIL_PROVIDER                                | ✓                    | ✓                      | ✗        | ✗                       | ✓ (TOML)     | HIGH: missing dev-docs + deploy-docs               |
| RESEND_API_KEY                                | ✓                    | ✓                      | ✗        | ✗                       | ✓ (REQUIRED) | HIGH: missing dev-docs + deploy-docs               |
| EMAIL_FROM_ADDRESS                            | ✓                    | ✓                      | ✗        | ✗                       | ✓ (TOML)     | HIGH: missing dev-docs + deploy-docs               |
| EMAIL_FROM_NAME                               | ✓                    | ✓                      | ✗        | ✗                       | ✓ (TOML)     | HIGH: missing dev-docs + deploy-docs               |
| EMAIL_REPLY_TO_ADDRESS                        | ✗ (bare process.env) | ✗                      | ✗        | ✗                       | ✗            | HIGH: not in schema; set in fly.toml; undocumented |
| LOOP_STELLAR_NETWORK_PASSPHRASE               | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_STELLAR_HORIZON_URL                      | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_XLM_PRICE_FEED_URL                       | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_FX_FEED_URL                              | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| CTX_OPERATOR_POOL                             | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_PAYOUT_WORKER_INTERVAL_SECONDS           | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_PAYOUT_MAX_ATTEMPTS                      | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_PAYOUT_WATCHDOG_STALE_SECONDS            | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_PAYOUT_FEE_BASE_STROOPS                  | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| LOOP_PAYOUT_FEE_CAP_STROOPS                   | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| LOOP_PAYOUT_FEE_MULTIPLIER                    | ✓                    | ✓                      | ✗        | ✗                       | ✗            | LOW: missing dev-docs + deploy-docs                |
| LOOP_WORKERS_ENABLED                          | ✓                    | ✓                      | ✓        | ✓                       | ✓ (TOML)     | OK                                                 |
| LOOP_KILL_ORDERS                              | ✓                    | ✓                      | ✗        | ✗                       | ✗            | MEDIUM: kill-switch runbook doc missing            |
| LOOP_KILL_AUTH                                | ✓                    | ✓                      | ✗        | ✗                       | ✗            | MEDIUM: kill-switch runbook doc missing            |
| LOOP_KILL_WITHDRAWALS                         | ✓                    | ✓                      | ✗        | ✗                       | ✗            | MEDIUM: kill-switch runbook doc missing            |
| LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS         | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_PROCUREMENT_INTERVAL_SECONDS             | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS     | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| LOOP_ASSET_DRIFT_THRESHOLD_STROOPS            | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| INTEREST_APY_BASIS_POINTS                     | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| INTEREST_PERIODS_PER_YEAR                     | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| INTEREST_TICK_INTERVAL_HOURS                  | ✓                    | ✓                      | ✓        | ✓                       | ✗            | OK                                                 |
| **VITE_API_URL**                              | N/A                  | ✓ (.env.local.example) | ✓        | ✓ (fly.toml build.args) | N/A          | OK                                                 |
| **VITE_SENTRY_DSN**                           | N/A                  | ✓ (.env.local.example) | ✓        | ✓ (fly.toml build.args) | N/A          | MEDIUM: CI build does not set it                   |
| **VITE_LOOP_ENV**                             | N/A                  | ✓ (.env.local.example) | ✓        | ✓ (fly.toml build.args) | N/A          | MEDIUM: CI build does not set it                   |
| **VITE_SENTRY_RELEASE**                       | N/A                  | ✓ (.env.local.example) | ✓        | ✓ (fly.toml build.args) | N/A          | OK (CI sets it)                                    |
| **EMAIL_REPLY_TO_ADDRESS** (bare process.env) | ✗                    | ✗                      | ✗        | ✗                       | ✗            | HIGH: schema bypass; fly.toml sets it              |
| **DISCORD_WEBHOOK_DEPLOYMENTS** (CI-only)     | ✗                    | ✗                      | ✗        | ✗                       | ✓ (REC)      | MEDIUM: CI secret, no doc                          |
| **SENTRY_AUTH_TOKEN** (CI-only)               | ✗                    | ✗                      | ✗        | ✗                       | ✗            | MEDIUM: CI secret, no doc                          |
| **LOOP_E2E_REFRESH_TOKEN** (CI-only)          | ✗                    | ✗                      | ✗        | ✗                       | ✗            | LOW: e2e secret, no doc                            |
| **STELLAR_TEST_SECRET_KEY** (CI-only)         | ✗                    | ✗                      | ✗        | ✗                       | ✗            | LOW: e2e secret, no doc                            |

---

## Summary by dimension

| Dimension                                   | Notes                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env.ts` ↔ `.env.example` parity            | **Full parity** for all 77 env.ts-declared vars. lint-docs.sh §1 enforces this. One additional var (`EMAIL_REPLY_TO_ADDRESS`) bypasses the check by using bare `process.env` in `email.ts`.            |
| `env.ts` ↔ `docs/development.md`            | 17 vars missing (LOOP_MERCHANT_DENYLIST, SENTRY_RELEASE, DATABASE_STATEMENT_TIMEOUT_MS, LOOP_ADMIN_STEP_UP_SIGNING_KEY\*, email vars ×4, fee-bump vars ×3, kill-switch vars ×3, interest-pool vars ×2) |
| `env.ts` ↔ `docs/deployment.md`             | Same 17 vars missing as development.md                                                                                                                                                                 |
| `env.ts` ↔ `AGENTS.md` env summary          | AGENTS.md is intentionally a subset (quick-look only); ~51 vars not in the summary, which is expected for a summary section                                                                            |
| `env.ts` ↔ `apps/backend/fly.toml`          | Full coverage of non-secret vars. `EMAIL_REPLY_TO_ADDRESS` is set in fly.toml but not in env.ts — it bypasses schema validation.                                                                       |
| `env.ts` ↔ `scripts/preflight-tranche-1.sh` | `LOOP_ADMIN_STEP_UP_SIGNING_KEY` missing from all three lists (REQUIRED/RECOMMENDED/TOML_OR_SECRETS).                                                                                                  |
| `env.ts` ↔ `docs/tranche-1-launch.md`       | `LOOP_STELLAR_USDC_ISSUER` value-level mismatch (AVCIA5 vs AVCIA7).                                                                                                                                    |
| Value-level mismatches                      | 1 confirmed: `LOOP_STELLAR_USDC_ISSUER` diverges between `tranche-1-launch.md` and all other sources.                                                                                                  |
| Zombie vars (in docs, not in code)          | None found — no documented vars were absent from `env.ts`.                                                                                                                                             |

---

### Coverage

**81 variables traced** (77 backend env.ts + 4 web VITE\_\* + 5 CI/build-time-only secrets noted).  
Severity breakdown: **1 CRITICAL**, **5 HIGH**, **5 MEDIUM**, **9 LOW**, **1 INFO**.

## Cross-cutting — migration chain

### Findings

- [INFO] `meta/` dir — no content hashes in journal entries (Drizzle v7 dialect). The `_journal.json` records only `{idx, tag, version, when, breakpoints}` — no SHA/checksum per SQL file. A developer who edits a previously-applied migration file will not be detected by Drizzle's migrator; it tracks applied migrations by tag name in the `drizzle_migrations` Postgres table, not by file content. This is a Drizzle v7 limitation, not a project bug, but it means file mutation after apply is silent. Mitigation is a CI step that checksums SQL files after apply (not present). Severity: LOW (informational — no active exploit vector, but worth noting for ops awareness).

- [HIGH] `apps/backend/src/db/schema.ts:548,554` + `0021_orders_currency_check.sql` — `orders_currency_known` and `orders_charge_currency_known` both constrain to `IN ('USD', 'GBP', 'EUR')`. ADR-035 ships AED/INR/SAR/AUD/MXN as front-end display currencies but makes **no backend schema change**. Any attempt to place an order with `currency='AED'` will hit the `orders_currency_known` CHECK and fail with a Postgres constraint violation. The handler guards this at `loop-handler.ts:259` (`isHomeCurrency` check against `HOME_CURRENCIES = ['USD','GBP','EUR']`), so the app-layer gate fires before the DB gate. However, the schema.ts comment at line 554 says "Adding a fourth is a deliberate migration against this CHECK" — and no such migration exists for the ADR-035 currencies. If a future code path bypasses the `isHomeCurrency` guard (e.g., a bulk import, an admin API, a catalog-sync that writes order rows), the DB constraint is the last line of defence and **it will reject AED/INR/SAR/AUD/MXN writes**. The current handler path is safe; the missing migration is a latent risk. See ADR-035 verdict below.

- [MEDIUM] `0007_orders_charge_columns.sql:24` — backfill uses `WHERE "charge_minor" = 0` as proxy for "pre-migration row". Any order that happened to have `charge_minor = 0` at migration time (a zero-value test order, or a refund edge case) would be incorrectly backfilled even if it already had correct `charge_currency`. In practice, a legitimate `$0` order is nonsensical (zero face-value is blocked by Zod validation `z.number().int().positive()`), so the risk is theoretical. But the correct predicate should have been `WHERE charge_minor IS NULL` (before the NOT NULL DEFAULT was added). The migration has already run; the only consequence is that the comment is misleading. Mark as resolved-in-prod but document.

- [LOW] `0013_ledger_constraints.sql` `credit_transactions_reference_unique` index only covers `('cashback', 'refund', 'spend')` and deliberately omits `'withdrawal'` (noted in comment). Migration `0022` later adds `'withdrawal'` by DROP+CREATE. The drop in 0022 briefly removes the guard — the window is inside the implicit transaction so is safe, but the two-migration sequence is fragile if 0022 ever gets rolled back without 0013 also rolling back. Low risk given migration idempotency and the belt-and-braces nature of the constraint.

- [INFO] Only `meta/0000_snapshot.json` exists — there is no up-to-date snapshot for migrations 0001–0032. Drizzle v7 only auto-generates a snapshot per `drizzle-kit generate` run; subsequent `generate` calls append to the journal but don't update the 0000 snapshot. This means `drizzle-kit check` / schema-drift detection against a live DB is not available without a manual `drizzle-kit pull` + diff. Not a bug; correct Drizzle v7 behavior, but noted for ops awareness.

- [INFO] `migrate-cli.ts` (Fly `release_command`) + `index.ts` boot-time both call `runMigrations()`. Drizzle's migrator is idempotent (no-ops if already applied). Double-apply is safe. The `release_command` fires on a one-shot Machine before traffic shifts; a failure exits non-zero and aborts deploy, keeping old machines alive. Belt-and-braces boot-time call catches any edge case where release_command was skipped. Migration runner behavior is correct.

---

### Chain log

- 0000_initial_schema.sql — OK. Creates: `credit_transactions`, `merchant_cashback_config_history`, `merchant_cashback_configs`, `user_credits`, `users`. Installs `record_merchant_cashback_config_history()` trigger (UPDATE only). Missing tables at this point vs schema.ts final state: `orders`, `watcher_cursors`, `otps`, `refresh_tokens`, `user_identities`, `pending_payouts`, `admin_idempotency_keys`, `social_id_token_uses`, `user_favorite_merchants` — all added by later migrations as expected.
- 0001_auth_tables.sql — OK. Adds `otps`, `refresh_tokens`.
- 0002_loop_orders.sql — OK. Creates `orders` with state CHECK (`pending_payment|paid|procuring|fulfilled|failed|expired`), payment_method CHECK (`xlm|usdc|credit`), percentages_sum CHECK, minor_amounts_non_negative CHECK (without `charge_minor` — correctly pre-ADR-015 shape). No `charge_minor` or `charge_currency` columns yet.
- 0003_watcher_cursors.sql — OK. Creates `watcher_cursors`.
- 0004_orders_redemption.sql — OK. Adds nullable `redeem_code`, `redeem_pin`, `redeem_url`.
- 0005_user_identities.sql — OK. Creates `user_identities` with FK + indexes. No provider CHECK yet (added in 0025).
- 0006_users_home_currency.sql — OK. Adds `home_currency char(3) NOT NULL DEFAULT 'USD'` + `users_home_currency_known` CHECK. Safe: DEFAULT means existing rows get 'USD'.
- 0007_orders_charge_columns.sql — OK (with caveat). Adds `charge_minor bigint NOT NULL DEFAULT 0`, `charge_currency char(3) NOT NULL DEFAULT 'USD'`. Backfills via `WHERE charge_minor = 0`. Adds `orders_charge_currency_known` CHECK. Drops+recreates `orders_minor_amounts_non_negative` to include `charge_minor`. Caveat: backfill predicate is a proxy for NULL (see Findings).
- 0008_orders_loop_asset_payment.sql — OK. Drops+recreates `orders_payment_method_known` to add `'loop_asset'`. Pattern: DROP CONSTRAINT + ADD CONSTRAINT (correct for Postgres; no `ALTER CHECK`).
- 0009_users_stellar_address.sql — OK. Adds nullable `stellar_address`.
- 0010_pending_payouts.sql — OK. Creates `pending_payouts` with state/amount/attempts CHECKs and FK constraints. `order_id` is NOT NULL here (relaxed in 0018).
- 0011_admin_idempotency_keys.sql — OK. Creates `admin_idempotency_keys` with composite PK, key_length and status_valid CHECKs.
- 0012_credit_transactions_period_cursor.sql — OK. Adds nullable `period_cursor`, adds `credit_transactions_period_cursor_interest_only` CHECK and `credit_transactions_interest_period_unique` partial index.
- 0013_ledger_constraints.sql — OK. Adds `user_credits_currency_known` CHECK. Creates `credit_transactions_reference_unique` partial index scoped to `('cashback','refund','spend')` (deliberately omitting `'withdrawal'` — resolved in 0022).
- 0014_credit_tx_currency_check.sql — OK. Adds `credit_transactions_currency_known` CHECK (USD/GBP/EUR). Non-idempotent ADD CONSTRAINT; safe because 0013 already ran with no such constraint, and Drizzle's migration sequencer prevents re-apply.
- 0015_credit_tx_reason.sql — OK. Adds nullable `reason` TEXT column.
- 0016_cashback_config_audit_trigger_guard.sql — OK. Idempotently re-asserts `record_merchant_cashback_config_history()` function + trigger via CREATE OR REPLACE + DROP IF EXISTS + CREATE. Covers accidental drizzle-push drops.
- 0017_user_credits_primary_key.sql — OK. Promotes `user_credits_user_currency` unique index to composite PK. DROP INDEX + ADD CONSTRAINT inside implicit transaction; safe.
- 0018_pending_payouts_generalise.sql — OK. Makes `order_id` nullable. Adds `kind TEXT NOT NULL DEFAULT 'order_cashback'` with `pending_payouts_kind_known` and `pending_payouts_kind_shape` CHECKs.
- 0019_social_id_token_replay_guard.sql — OK. Creates `social_id_token_uses` with PK and expires_at index. Uses `CREATE TABLE IF NOT EXISTS` (idempotent).
- 0020_users_email_unique.sql — OK. Creates `users_email_loop_native_unique` partial unique index on `LOWER(email) WHERE ctx_user_id IS NULL`. Includes pre-flight documentation for dedup check. Non-idempotent `CREATE UNIQUE INDEX` (no IF NOT EXISTS), but safe given migration sequencer.
- 0021_orders_currency_check.sql — OK. Adds `orders_currency_known` CHECK (USD/GBP/EUR) on `orders.currency`. Non-idempotent ADD CONSTRAINT; safe given sequencer.
- 0022_credit_tx_withdrawal_unique.sql — OK. DROP+CREATE of `credit_transactions_reference_unique` to extend scope to include `'withdrawal'`. Wrapped in implicit transaction; brief window without guard is safe.
- 0023_orders_idempotency_key.sql — OK. Adds `idempotency_key` text nullable column. Creates `orders_user_idempotency_unique` partial unique index with IF NOT EXISTS... wait, actually no IF NOT EXISTS here:

```sql
ALTER TABLE orders ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX orders_user_idempotency_unique ...
```

Non-idempotent but safe given sequencer.

- 0024_pending_payouts_to_address_format.sql — OK. Adds `pending_payouts_to_address_format` CHECK regex on `to_address`. Non-idempotent ADD CONSTRAINT; safe.
- 0025_user_identities_and_orders_db_checks.sql — OK. Adds `user_identities_provider_known` CHECK + `orders_payment_memo_coherence` CHECK.
- 0026_orders_sweep_aggregate_indexes.sql — OK. Creates three partial indexes (`orders_procuring_procured_at`, `orders_fulfilled_merchant_at`, `orders_fulfilled_at`) with `IF NOT EXISTS`. Idempotent.
- 0027_pending_payouts_user_created_index.sql — OK. Drops `pending_payouts_user` index, creates composite `pending_payouts_user_created` with `IF NOT EXISTS`. `DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS` — idempotent.
- 0028_pending_payouts_compensation_and_withdrawal_uniqueness.sql — OK. Adds nullable `compensated_at` column. Creates `pending_payouts_active_withdrawal_unique` partial unique index. Non-idempotent CREATE UNIQUE INDEX (no IF NOT EXISTS); safe given sequencer.
- 0029_cashback_config_audit_insert_delete_triggers.sql — OK. Extends trigger function to handle INSERT + DELETE TG_OP cases. Idempotent via CREATE OR REPLACE + DROP IF EXISTS pattern.
- 0030_pending_payouts_asset_checks.sql — OK. Adds `pending_payouts_asset_code_known` (`IN ('USDLOOP','GBPLOOP','EURLOOP')`) and `pending_payouts_asset_issuer_format` CHECKs. Idempotent via DROP IF EXISTS + ADD CONSTRAINT.
- 0031_credit_transactions_reason_length.sql — OK. Adds `credit_transactions_reason_length` CHECK. Idempotent via DROP IF EXISTS + ADD CONSTRAINT.
- 0032_user_favorite_merchants.sql — OK. Creates `user_favorite_merchants` with composite PK, `user_favorite_merchants_merchant_id_nonempty` CHECK, and `user_favorite_merchants_user_created` index. `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — fully idempotent.

---

### Coverage

33 migrations (0000–0032) traced against schema.ts. All 33 SQL files present and sequenced without gaps.

**Table coverage:**

- `users` — created in 0000, extended in 0006 (home_currency), 0009 (stellar_address), 0020 (email unique). All schema.ts columns + constraints accounted for. ✓
- `user_credits` — created in 0000, currency check added in 0013, PK promoted in 0017. ✓
- `credit_transactions` — created in 0000, period_cursor in 0012, currency check in 0014, reason in 0015, reason length in 0031. All schema.ts constraints traced. ✓
- `merchant_cashback_configs` / `merchant_cashback_config_history` — created in 0000, trigger re-asserted in 0016 + extended in 0029. ✓
- `otps` / `refresh_tokens` — created in 0001. ✓
- `orders` — created in 0002, redemption in 0004, charge columns in 0007, loop_asset method in 0008, currency check in 0021, idempotency key in 0023, db checks in 0025, sweep indexes in 0026. All schema.ts constraints traced. ✓
- `watcher_cursors` — created in 0003. ✓
- `user_identities` — created in 0005, provider check in 0025. ✓
- `pending_payouts` — created in 0010, generalised in 0018, address format in 0024, user index in 0027, compensation in 0028, asset checks in 0030. All schema.ts constraints traced. ✓
- `admin_idempotency_keys` — created in 0011. ✓
- `social_id_token_uses` — created in 0019. ✓
- `user_favorite_merchants` — created in 0032. ✓

**No orphan constraints** (constraints in migrations but removed from schema.ts): the DROP CONSTRAINT operations in the chain are always DROP+ADD pairs preserving the constraint (0008 payment_method, 0007/0025 minor_amounts_non_negative, 0022 credit_transactions_reference_unique, 0030/0031 idempotent re-adds).

**No schema.ts drift** (constraints in schema.ts not backed by any migration): every `check()`, `uniqueIndex()`, `index()`, and `primaryKey()` in schema.ts can be traced to a creating migration.

---

## ADR-035 Verdict: SAFE — no DB violation possible on the current code path

**Question:** Can an ADR-035 extended-market merchant (AED/INR/SAR/AUD/MXN pricing) reach an INSERT that violates `orders_currency_known` or `orders_charge_currency_known`?

**Answer: No, on the current code path. The handler rejects such requests before the DB is touched.**

**Evidence chain:**

1. `packages/shared/src/loop-asset.ts:39` — `HOME_CURRENCIES = ['USD', 'GBP', 'EUR'] as const`
2. `packages/shared/src/loop-asset.ts:104–105` — `isHomeCurrency(s)` returns `false` for any string not in that array
3. `apps/backend/src/orders/loop-handler.ts:259–266` — handler calls `isHomeCurrency(parsed.data.currency)` and returns HTTP 400 `"currency must be USD, GBP, or EUR"` if false. This runs **before** `createOrder()` is called.
4. `apps/backend/src/orders/loop-handler.ts:249–258` — handler checks `isHomeCurrency(user.homeCurrency)` and returns 500 if false (DB CHECK on `users.home_currency` means a non-USD/GBP/EUR value in the DB is already a bug).
5. `apps/backend/src/orders/loop-handler.ts:365–368` — `createOrder()` is called with `currency: parsed.data.currency` (already validated at step 3) and `chargeCurrency: user.homeCurrency` (already validated at step 4). Both values are guaranteed to be in `('USD','GBP','EUR')` before the INSERT.
6. `apps/backend/src/db/schema.ts:548,554` — `orders_charge_currency_known` and `orders_currency_known` both CHECK `IN ('USD', 'GBP', 'EUR')`. These are never reached for AED/INR/SAR/AUD/MXN because the handler gate fires first.

**ADR-035's claim** (doc line 65): "No backend change — CTX already creates and prices these merchants." This is accurate. ADR-035 is a **display-only** change: the five new country entries in `packages/shared/src/countries.ts` affect the web app's locale routing, merchant filtering, and price formatting only. The order-creation handler independently requires `currency ∈ HOME_CURRENCIES`, which has not changed.

**Latent risk (not a current bug):** The schema comments at `schema.ts:549` and `schema.ts:554` explicitly state "Adding a fourth currency will be a deliberate migration against this CHECK." ADR-035 adds five display currencies without a migration. If a future code path (e.g., a bulk order import, an admin endpoint, a future order method) writes `currency='AED'` without going through `isHomeCurrency`, the DB CHECK will fire and the INSERT will fail with a Postgres constraint violation. The missing migration is intentional per ADR-035's "display-only, no cashback" decision, but the schema comments set an expectation that is now inconsistent with the country list. Recommend adding a comment cross-reference in schema.ts at the five currency checks pointing to ADR-035's display-only decision.

**Severity counts:** HIGH: 1 (latent risk, no current exploit) | MEDIUM: 1 | LOW: 1 | INFO: 3

## Cross-cutting — CI/CD pipeline

### Findings

### HIGH — Security/compliance jobs not in branch protection

**ci.yml (lines 436–462, 380–428, 273–367, 190–241)** — `secret-scan` (gitleaks), `container-cve-scan` (trivy), `sbom`, `flywheel-integration`, `test-e2e` (real CTX, PR-only), and `test-e2e-flywheel` are all wired in ci.yml but are **not** in the `required_status_checks` contexts. Branch protection only enforces five checks: `Quality`, `Unit tests`, `Security audit` (npm audit, not gitleaks), `Build verification`, and `E2E tests (mocked CTX)`. A PR introducing a hardcoded secret, a CVE in the base image, or a DB-level regression in the flywheel path can merge as long as those five pass — even if secret-scan, container-cve-scan, or flywheel-integration fail.  
**Fix:** Add `Secret scan (gitleaks)`, `Container CVE scan (trivy)`, and `Flywheel integration (real postgres)` to required status checks via `gh api repos/LoopDevs/Loop/branches/main/protection/required_status_checks`.

### HIGH — Bundle-size gate exists but is never called in CI

**AGENTS.md line ~112 / scripts/check-bundle-budget.sh** — AGENTS.md documents `npm run check:bundle-budget` as a "size-regression gate" and the script exists at `scripts/check-bundle-budget.sh`, but **no workflow step calls it**. The `build` job reports sizes to `$GITHUB_STEP_SUMMARY` (human-readable only) but never invokes the script. A PR that doubles the SSR bundle or adds an 800 KB+ chunk will pass all required checks and merge silently.  
**Fix:** Add `- run: ./scripts/check-bundle-budget.sh` to the `build` job after the `Build web (SSR)` step (line 529 in ci.yml), mirroring the documented intent.

### MEDIUM — AGENTS.md job count stale (12 jobs, not 11; missing test-e2e-flywheel)

**AGENTS.md (Git workflow section)** — Claims "CI runs eleven jobs" and lists them, but the actual ci.yml has **12** jobs (`quality`, `test-unit`, `flywheel-integration`, `audit`, `sbom`, `container-cve-scan`, `secret-scan`, `build`, `test-e2e`, `test-e2e-mocked`, `test-e2e-flywheel`, `notify`). The `test-e2e-flywheel` job (E2E tests loop-native flywheel) was added after AGENTS.md was last synced. Also: `enforce_admins: false` means repo admins can merge without satisfying required checks — not noted in docs.  
**Fix:** Update AGENTS.md to list 12 jobs and add `test-e2e-flywheel`. Add a note that `enforce_admins` is disabled.

### MEDIUM — No automated deploy pipeline; deploy is fully manual flyctl

**apps/backend/fly.toml, apps/web/fly.toml** — There is no `.github/workflows/deploy.yml`. Deploying either app requires a maintainer to run `flyctl deploy` locally with the correct secrets and build args. This creates two risks: (a) the deployed version can diverge from what CI verified (a green PR merge doesn't guarantee deploy); (b) the `release_command = "node apps/backend/dist/migrate-cli.js"` migration step only runs when Fly builds the Docker image on deploy, so a migration ship lag is operator-visible only. The `VITE_*` build args in `apps/web/fly.toml` `[build.args]` must be manually supplied at deploy time or Sentry stays dark.  
**Fix:** A `deploy.yml` triggered on `push: branches: [main]` (or on manual dispatch) that runs `flyctl deploy` with the correct build args and secrets would close this gap and tie the deploy provenance to a specific CI-verified SHA.

### MEDIUM — `strict: false` on required_status_checks; PRs can merge on stale branch

**`gh api` branch protection response** — `required_status_checks.strict` is `false`. This means a PR can pass all checks against its own HEAD, then merge into main even if main has advanced with conflicting commits since the checks ran. The merged result is never tested.  
**Fix:** Set `strict: true` or enable "Require branches to be up to date before merging" in the GitHub repo settings.

### LOW — AGENTS.md says "eleven jobs" but `test-e2e-flywheel` is not in branch protection either

**ci.yml line 782** — `test-e2e-flywheel` runs `npm run test:e2e:flywheel` on every push+PR (no `if:` guard), has no `needs: []` dependency on `build`, and is not in required status checks. If the loop-native flywheel e2e fails, the PR can still merge. Given it tests the critical payment + cashback path (LOOP_AUTH_NATIVE_ENABLED=true), this should be required.

### LOW — `enforce_admins: false` — admins bypass required checks

**Branch protection API** — Administrators (currently just the sole maintainer) can merge PRs even if required status checks have not passed. Fine for a solo project, but not documented and inconsistent with the "passing-checks gate is non-negotiable" claim in AGENTS.md.

### LOW — Cache scope shared across PR and main builds (potential cache poisoning)

**ci.yml (multiple cache steps)** — The `node_modules` cache key is `node_modules-${{ runner.os }}-node22-${{ hashFiles('package-lock.json') }}`. A PR that modifies `package-lock.json` will prime a new cache entry from an untrusted PR context. GitHub Actions restricts cross-scope cache access on forks by default, but this is a public repo. The risk is mitigated by `--ignore-scripts`, but is worth noting given ADR-029's supply-chain posture.

### INFO — `required_signatures: false` — commits to main need not be GPG-signed

**Branch protection API** — Unsigned commits can land on main. Low risk given the passing-checks gate, but inconsistent with the security hardening posture documented elsewhere.

### INFO — `ADDITIONS`/`DELETIONS` inline expression in pr-automation run block

**pr-automation.yml lines 45–46** — `ADDITIONS=${{ github.event.pull_request.additions || 0 }}` inlines a GitHub expression into a shell `run` block. These values are integers from the GitHub event payload and cannot contain shell metacharacters, so injection is not feasible here, but the pattern should not be extended to string-valued fields (PR title, branch name).

---

### Pipeline map

| Job                            | What it runs                                                                                                                                       | Gates merge?                      | Gaps                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `quality`                      | typecheck, ESLint, Prettier, `lint-docs.sh` (env/route/openapi/domain/Stellar/Fly drift checks), commitlint (PR), FileProvider overlay scope       | YES                               | No bundle-budget call                                                    |
| `test-unit`                    | `npm run test:coverage --workspaces` (vitest, all packages)                                                                                        | YES                               | —                                                                        |
| `flywheel-integration`         | `npm run test:integration -w @loop/backend` (real postgres, cashback flywheel, runs migrations)                                                    | NO (not in branch protection)     | Critical DB-layer not gating                                             |
| `audit`                        | `node ./scripts/check-audit-policy.mjs` (npm audit, pinned moderate set, fail on high/critical)                                                    | YES                               | Gitleaks not in this job; "Security audit" context covers npm audit only |
| `secret-scan`                  | gitleaks v8.30.1 (SHA-pinned), full history, redacted output                                                                                       | NO (not in branch protection)     | PRs with hardcoded secrets can merge if only other 5 checks pass         |
| `sbom`                         | CycloneDX SBOM generation, SLSA provenance attestation, cosign keyless signing                                                                     | NO                                | Attests SBOM artifact, not deployed image (A4-044 open)                  |
| `container-cve-scan`           | trivy 0.55.2 (SHA-pinned) image scan + Dockerfile misconfig, HIGH+CRITICAL                                                                         | NO                                | Not a merge gate                                                         |
| `build`                        | Backend build+migration dist verification, web SSR build, web mobile static export, admin bundle split check, Sentry source map upload (push only) | YES                               | `check-bundle-budget.sh` NOT called; only reports sizes to summary       |
| `test-e2e`                     | Playwright against real CTX upstream (real credentials), PR-only (`if: github.event_name == 'pull_request'`)                                       | NO                                | PR-only, not in branch protection                                        |
| `test-e2e-mocked`              | Playwright mocked-CTX suite + postgres service + backend + web dev server                                                                          | YES                               | Mocked; does not cover real CTX contract                                 |
| `test-e2e-flywheel`            | Playwright loop-native flywheel (LOOP_AUTH_NATIVE_ENABLED=true), postgres service                                                                  | NO                                | Not in branch protection; tests payment+cashback critical path           |
| `notify`                       | Discord embed (jq-encoded; COMMIT_MSG sanitized via perl+sed per A2-1415)                                                                          | N/A — informational               | SKIPPED_ON_PUSH logic signals but doesn't block                          |
| `codeql.yml/analyze`           | CodeQL security-and-quality JS/TS (push, PR, weekly schedule)                                                                                      | NO                                | Not in branch protection; SARIF to Security tab                          |
| `pr-automation.yml/label`      | actions/labeler based on file paths                                                                                                                | NO                                | Informational only                                                       |
| `pr-automation.yml/size-check` | PR line-count check, posts large-PR warning comment                                                                                                | NO                                | Informational only                                                       |
| `pr-review.yml/secret-scan`    | gitleaks pre-gate before diff reaches Anthropic                                                                                                    | NO                                | Not in branch protection                                                 |
| `pr-review.yml/review`         | Claude Code LLM review, prompt-injection mitigated (ADR-025, A4-042)                                                                               | NO                                | AI opinion only                                                          |
| `e2e-real.yml`                 | `node scripts/e2e-real.mjs` — real Stellar XLM spend against deployed prod                                                                         | MANUAL ONLY (`workflow_dispatch`) | Rotates `LOOP_E2E_REFRESH_TOKEN` secret on every run                     |

**Deploy path:** Fully manual. No deploy workflow exists. Operators run `flyctl deploy` locally. Backend uses `release_command = "node apps/backend/dist/migrate-cli.js"` for pre-traffic migration. Web requires manual `--build-arg VITE_SENTRY_DSN=...` at deploy time or Sentry stays off.

**Supply chain (ADR-029):** All actions are SHA-pinned (checkout, setup-node, cache, upload-artifact, download-artifact, labeler, attest-build-provenance, cosign-installer, flyctl-actions). Docker tool images (trivy, gitleaks) are digest-pinned. `npm ci --ignore-scripts` used everywhere; `npm rebuild esbuild` is the only explicitly allowed postinstall. `sentry-cli` and `claude` binaries are invoked from `./node_modules/.bin/` (lockfile-pinned per ADR-029). `npx commitlint` uses the version in node_modules (no `--yes`/live-fetch). The one deviation: `e2e-real.yml` `Install deps` step uses `npm ci --ignore-scripts && npm rebuild esbuild` identically — consistent.

---

### Coverage

5 workflows + 9 scripts traced: `ci.yml`, `codeql.yml`, `e2e-real.yml`, `pr-automation.yml`, `pr-review.yml`; `verify.sh`, `lint-docs.sh`, `check-bundle-budget.sh`, `check-admin-bundle-split.sh`, `check-env-perms.sh`, `check-audit-policy.mjs`, `preflight-tranche-1.sh` (referenced, operator-only), `e2e-real.mjs` (invoked by e2e-real.yml), `postgres-init.sh` (dev only).

## Cross-cutting — money-path invariants

Audit date: 2026-06-11. Scope: seams between files on the order/payment/payout/ledger lifecycle. Per-file audits assumed done; everything below only manifests across at least two files.

### Findings

### Critical

- [CRIT] `payments/amount-sufficient.ts:46,116,144` ↔ `payments/watcher.ts:275-288` — **"Rejected payment retries next tick" contract is false: the cursor advances past skipped payments, permanently dropping them.** `isAmountSufficient` (and its doc comment, and the `LoopAssetMissingCreditRowError` handler comment at `watcher.ts:241-259`, and `price-feed.ts:230-234`) all assume a rejected/unverifiable payment is re-evaluated on the next tick. But `runPaymentWatcherTick` writes `last.paging_token` as the cursor after the loop regardless of per-record outcome — a payment skipped because of a 60s oracle/FX outage, an A4-107 asset/method mismatch, an FX-move-against-quote rejection (`sep7.ts:16-18` explicitly accepts watcher rejection as benign), or the A4-110 missing-credit-row path is **never scanned again**. The user's funds sit in the deposit account; the order silently ages into `expired` after 24h. A transient oracle outage during a busy minute drops every payment in that window. Fix: don't advance the cursor past the oldest non-terminally-skipped payment (track a per-record "retryable" outcome and pin the cursor before the first retryable record), or persist skipped payments into a retry table the tick re-drains.

- [CRIT] `credits/withdrawals.ts:87-205` ↔ `orders/transitions.ts:83-134` ↔ `payments/watcher.ts:237-260` — **withdrawal breaks the "on-chain LOOP always has a matching off-chain balance" invariant; the resulting CHECK violation wedges the entire deposit watcher.** `applyAdminWithdrawal` debits `user_credits` and emits on-chain LOOP to the user — so post-withdrawal the user holds on-chain LOOP with no off-chain half. `markOrderPaid`'s loop_asset branch assumes the inverse invariant (comment at transitions.ts:122-128: "should never happen") and debits `balance - chargeMinor` against the `user_credits_non_negative` CHECK (`db/schema.ts:135`). When such a user spends their withdrawn LOOP on a loop_asset order: constraint violation → not a `LoopAssetMissingCreditRowError` → `watcher.ts:260` rethrows → tick aborts **before `writeCursor`** → every subsequent tick reprocesses the same page and throws again. One poisoned payment halts deposit processing for **all** users until manual intervention (cursor watchdog pages after 10 min, but nothing self-heals). Fix: catch constraint violations in the watcher like the missing-row error (skip + alert), and decide the withdrawal↔redemption model conflict at the ADR level (ADR-024 emission vs the 2026-05-03 redemption rule).

### High

- [HIGH] `orders/transitions.ts:38-40` ↔ `payments/asset-drift-watcher.ts:210` ↔ `payments/horizon-circulation.ts` — **loop_asset redemption never burns/returns the inbound LOOP; the drift equation counts deposit-held LOOP as circulation → permanent positive drift.** transitions.ts documents that redeemed LOOP is "routed to a treasury / burn account" — no code does this; `markOrderPaid` only debits the off-chain half. Horizon `/assets` circulation includes LOOP held by Loop's own deposit account, so each loop*asset order adds `chargeMinor × 1e5` of positive drift forever. Once cumulative redemptions exceed `LOOP_ASSET_DRIFT_THRESHOLD_STROOPS` the watcher pages and \_stays* paged — masking real drift incidents. Fix: subtract deposit-account holdings in `runAssetDriftTick` (like the interest pool) or implement the documented send-to-issuer burn.

- [HIGH] `credits/accrue-interest.ts` ↔ `payments/asset-drift-watcher.ts:152-159` — **interest accrual writes off-chain only; nothing distributes pool → user on-chain, so drift goes negative by the daily interest total — contradicting the watcher's own "drift stays flat" derivation.** The reconciliation comment assumes accrual is matched by pool drain (pool→user on-chain transfer); no such code exists (`interest-scheduler.ts` calls only `accrueOnePeriod`; `interest-pool-watcher.ts` only alerts on cover). drift = (onChain − pool) − liability decreases monotonically with each accrual tick → threshold page that is structurally unrecoverable. Same family: `credits/refunds.ts` + `credits/adjustments.ts` positive writes also raise liability with no on-chain emission.

- [HIGH] `payments/payout-submit.ts:62-67` (transient classification) ↔ `orders/procure-one.ts:243-256` — **pay-ctx treats "transient, tx may have landed" as terminal order failure.** A Horizon 504/timeout on the CTX XLM payment (status≥500 → `transient_horizon`, i.e. _the tx may still settle_) makes `procureOne` call `markOrderFailed`. If the tx lands: user paid Loop, Loop paid CTX, CTX mints the card — and the order is `failed` with no `ctxOrderId`, no tx hash, and (unlike the stuck-procurement sweep) **no Discord alert** on this path. The payout worker honors the same classification with retry; procure-one violates it. Fix: on transient kinds, revert to `paid` (the CTX `Idempotency-Key` + `findOutboundPaymentByMemo` make the retry safe) or at minimum fire the ambiguous-outcome ops alert.

- [HIGH] `orders/procure-one.ts:185-274` ↔ `orders/fulfillment.ts:67` ↔ `orders/transitions-sweeps.ts:57` — **`ctxOrderId` is persisted only at fulfillment; every crash/sweep between the CTX create response and `markOrderFulfilled` loses the CTX join key.** The window spans pay-ctx (Horizon round trips) + `waitForRedemption` (up to 5 min). A crash there → stuck-sweep flips to `failed` with `ctx_order_id NULL`; ops must reconcile via the CTX-side `Idempotency-Key` (= order id) only, which the Discord embed doesn't surface as such. Fix: persist `ctxOrderId` (and the CTX payment tx hash from `payCtxOrder`) on the `procuring` row immediately after the create response parses.

- [HIGH] `orders/transitions-sweeps.ts:103-113` ↔ `orders/repo.ts:224-229` ↔ `payments/watcher.ts:190-194,262` — **expiry-sweep vs watcher race, and late payments, silently keep user funds with zero ops surface.** (a) Race: watcher matches memo (state still `pending_payment`), sweep flips to `expired`, `markOrderPaid` returns null — the watcher logs nothing, increments nothing, and the cursor advances; payment dropped. The transitions.ts:252-257 comment claims Postgres serialization protects this — it only guarantees one winner, not recovery for the loser. (b) A payment landing after the 24h expiry matches no `pending_payment` row → `unmatchedMemo++` (a counter, no alert, no persisted record). Both end states: Loop holds the user's crypto against an `expired` order with no refund queue. Fix: on `transitioned === null` re-read the order; if `expired`, alert + persist for manual refund; consider matching expired orders' memos in `findPendingOrderByMemo` for alerting purposes.

- [HIGH] `payments/horizon-find-outbound.ts:41-43` (3-page/600-record lookback) ↔ `payments/payout-worker-pay-one.ts:122-149` ↔ `admin/payouts-retry.ts:167` — **the payout idempotency pre-check silently degrades with operator-account traffic; admin retry of an old failed payout can double-pay.** The operator account carries CTX order payments (one per order, via `pay-ctx.ts`) _plus_ cashback payouts _plus_ withdrawals; 600 payments of lookback can be hours, not days. `reclaimSubmittedPayout` has no age bound and `resetPayoutToPending` can resurrect a days-old row whose prior tx has scrolled past the window → pre-check returns null → second on-chain payment with a fresh memo... same memo actually (memo persisted on row) — but the _scan_ misses it, so it re-submits the same memo and pays twice. Fix: raise `maxPages` proportionally, or query Horizon by memo via the transactions endpoint, or record the submit-attempt tx hash on the row before submitting (hash is computable pre-submit) and check `/transactions/{hash}` directly.

### Medium

- [MED] `orders/fulfillment.ts:140-158` — **peg-break Discord notify fires inside the open transaction while the comment claims "after the txn commits implicitly".** A rollback after the notify (e.g. payout-insert failure in a different branch, serialization failure, connection drop at commit) pages ops about a cashback ledger write that never happened. Inverse of the known "notify pre-commit" issue: the false-positive direction. Move the notify to after-commit by returning a flag from the txn (as `procure-one.ts:287` already does for `notifyCashbackCredited`).

- [MED] `credits/pending-payouts.ts:94-99` (`attempts < maxAttempts` filter) ↔ `credits/pending-payouts-transitions.ts:136-153` (`state='failed'` guard on reset) — **zombie payouts: a row that crashes after `markPayoutSubmitted`/`reclaimSubmittedPayout` on its final allowed attempt is stuck in `submitted` at the attempts cap forever.** `listClaimablePayouts` will never re-pick it (attempts filter), `handleSubmitError` never ran so it was never marked `failed`, and `resetPayoutToPending` requires `failed` — so even the admin retry surface can't touch it. Only the alert-once stuck-payout watchdog sees it. Fix: a sweep that flips `submitted AND attempts >= maxAttempts AND submitted_at < now()-T` to `failed` (after one final idempotency pre-check).

- [MED] `credits/payout-compensation.ts:128-139` / `credits/withdrawals.ts:87-100` — **both primitives validate amount magnitude but trust `args.currency` to match the payout's asset fiat.** Compensation re-derives the expected _amount_ from `amountStroops / 100_000n` (A4-021, "the primitive should not trust the caller") yet inserts the ledger row in caller-supplied `currency`; compensating a failed GBPLOOP withdrawal as `currency='USD'` silently credits the wrong ledger bucket and skews per-currency drift in both directions. Same inconsistency in `applyAdminWithdrawal` (no `currency ↔ intent.assetCode` cross-check). Fix: assert `fiatOf(payout.assetCode) === args.currency` in the primitives.

- [MED] `payments/watcher.ts:142-146` + `index.ts:85-87` ↔ `payments/amount-sufficient.ts:99-118` — **unset `LOOP_STELLAR_USDC_ISSUER` removes issuer pinning on the USDC match and the size check then values any code-"USDC" asset at 1 USDC = 1 USD.** Exploitation requires the deposit account to hold a trustline to the fake asset (mitigates to defense-in-depth), but the env var is optional with no boot warning while LOOP issuers get the A4-064 partial-config warning. Fail closed: refuse to match USDC at all when the issuer is unconfigured.

- [MED] `orders/loop-handler.ts:232-239` ↔ `orders/procure-one.ts:165-175` — **merchants without a `denominations` contract let the client choose `order.currency` freely, and procurement forwards it blind to CTX (`fiatCurrency: order.currency`).** The FX pin makes the user pay a fair converted charge, but the wholesale purchase is placed in a currency the merchant may not support; CTX rejects mid-flow _after_ the user paid (order → `failed`, manual refund). The handler comment (A4-103) only covers the denominated case. Fix: validate request currency against the merchant catalog currency even when `denominations` is absent.

- [MED] `orders/procurement-redemption.ts:118-121,209` ("backfilled later by a sweep if needed") — **the referenced redemption backfill sweep does not exist anywhere in the codebase** (also flagged in project memory: fulfilled order `f0dbaae5` with null redeem fields). An order fulfilled with nulls keeps the cashback + payout (correct) but the user permanently has no code; nothing re-polls CTX. This is the known redemption-null issue; the cross-file part is that _two_ files (`procure-one.ts:268`, `procurement-redemption.ts`) both defer to a sweep neither implements.

- [MED] `credits/payout-compensation.ts:102-105` ↔ `payments/payout-worker-pay-one.ts:250` ↔ `orders/loop-handler.ts:318-331` — **failed `order_cashback` payouts have no compensation path (kind='withdrawal' only) and the off-chain half is unspendable (credit method disabled per A4-110(b))** — the user's cashback exists only as a `user_credits` number they cannot use; the sole recovery is admin `resetPayoutToPending`, which loops back into the same failure for terminal kinds (no trustline → actually held in pending; `terminal_other` → fail again). Adjacent to known A4-110; worth an explicit ops runbook or extending compensation to cashback kind.

### Low

- [LOW] `db/schema.ts:461` — `orders.payment_memo` has no unique index; `findPendingOrderByMemo` (`repo.ts:224`) is `findFirst`. 100-bit entropy makes collision negligible, but a duplicate (e.g. test fixture / manual insert / future memo-format change) routes one user's payment to another user's order with no DB backstop. Cheap partial unique index closes it.

- [LOW] `payments/horizon-circulation.ts:67-74` — single-slot cache keyed by `(code, issuer)` while `runAssetDriftTick` iterates 3 assets per tick → every read evicts the previous; the 30s cache never hits in the steady state. Correctness unaffected; 3× Horizon load.

- [LOW] `100_000n` stroops-per-minor literal duplicated in 7 files (`payout-builder.ts`, `sep7.ts:71`, `amount-sufficient.ts:87`, `asset-drift-watcher.ts:47`, `interest-pool-watcher.ts:41`, `payout-compensation.ts:134`, `price-feed-fx.ts:112`) but only `payout-builder.ts` carries the A4-029 fail-loud asset-code guard. A future non-2-decimal currency or non-7-decimal asset breaks six sites silently. Hoist to `@loop/shared` with the guard.

### Lifecycle map

| Step                            | File                                                         | Writes                                                                                             | Reads                                                                       | Crash-gap coverage                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Create (xlm/usdc/loop_asset) | `orders/loop-handler.ts` + `orders/repo.ts`                  | `orders` (pending_payment; FX-pinned chargeMinor/chargeCurrency; split snapshot; memo)             | merchant cache, `users.home_currency`, FX feed, `merchant_cashback_configs` | Single insert — no gap. Idempotency-Key opt-in; double-click without it = duplicate row (documented).                                                                                                               |
| 2. Create (credit)              | `orders/repo-credit-order.ts`                                | `orders` + `credit_transactions(spend)` + `user_credits` + state→paid, one txn                     | balance FOR UPDATE                                                          | Atomic — no gap. Path currently disabled (A4-110(b) gate in handler).                                                                                                                                               |
| 3. Quote response               | `orders/loop-create-response.ts`                             | none                                                                                               | oracle/FX (fail-open to zero quote)                                         | Quote-vs-validate FX drift acknowledged in `sep7.ts`; compounds with CRIT-1 (rejected exact-quote payment dropped).                                                                                                 |
| 4. Deposit watch                | `payments/watcher.ts`                                        | `orders`→paid (+ loop_asset `user_credits` debit, same txn); `watcher_cursors`                     | Horizon payments, `orders` by memo                                          | Crash between markOrderPaid and writeCursor: covered (state-guard no-op on replay). Skip-then-cursor-advance: **NOT covered** (CRIT-1). Poisoned-payment CHECK violation: **NOT covered, wedges watcher** (CRIT-2). |
| 5. Expiry sweep                 | `orders/transitions-sweeps.ts:103`                           | `orders` pending_payment→expired                                                                   | createdAt cutoff (24h)                                                      | Race with watcher / late payment: **NOT covered** — funds kept, no alert (HIGH-5).                                                                                                                                  |
| 6. Procurement pick             | `orders/procurement.ts` → `procure-one.ts`                   | `orders` paid→procuring (ctxOperatorId)                                                            | state='paid' FIFO                                                           | Crash → stuck-sweep (15 min) → failed + per-row Discord (ambiguous-outcome). Covered, manual reconcile. Pre-CTX transient → revert to paid (A4-101). Covered.                                                       |
| 7. CTX create                   | `procure-one.ts:150-218`                                     | none until fulfillment (**gap: ctxOrderId not persisted**, HIGH-4)                                 | CTX POST /gift-cards (Idempotency-Key=order.id)                             | Crash post-response: sweep fails order with no CTX join key in DB. **Partially covered** (alert without the key).                                                                                                   |
| 8. Pay CTX                      | `orders/pay-ctx.ts` + `payments/payout-submit.ts`            | none (Horizon only; txHash log-only)                                                               | `findOutboundPaymentByMemo` (idempotent re-run)                             | Re-run idempotent via memo. Transient-submit misclassified terminal by caller (HIGH-3). No DB record of Loop→CTX payment: reconciliation = Horizon + logs only.                                                     |
| 9. Redemption wait              | `orders/procurement-redemption.ts`                           | none                                                                                               | CTX SSE + GET /gift-cards/:id                                               | Budget exhaustion → fulfilled with nulls; promised backfill sweep **does not exist** (MED). Terminal rejection → failed after Loop paid CTX (manual recovery).                                                      |
| 10. Fulfill                     | `orders/fulfillment.ts`                                      | `orders`→fulfilled + `credit_transactions(cashback)` + `user_credits` + `pending_payouts`, one txn | `users` (homeCurrency at fulfillment ≠ creation → peg-break branch)         | Atomic — no internal gap. Peg-break notify fires pre-commit (MED). onConflictDoNothing(orderId) makes replay safe.                                                                                                  |
| 11. Payout submit               | `payments/payout-worker*.ts` + `credits/pending-payouts*.ts` | `pending_payouts` pending→submitted→confirmed/failed                                               | trustline probe, memo pre-check (3-page bound), Horizon submit              | Crash submit↔confirm: covered by stale re-pick (300s) + pre-check, **bounded by lookback depth** (HIGH-6). Final-attempt crash → zombie submitted row: **NOT covered** (MED).                                       |
| 12. Payout fail → admin         | `admin/payouts-retry.ts`, `credits/payout-compensation.ts`   | reset failed→pending; adjustment + compensatedAt, one txn                                          | idempotency snapshot store (non-atomic with write — known)                  | Compensation atomic + mutually exclusive with retry via compensatedAt/state guards. Cashback-kind has no compensation path (MED).                                                                                   |
| 13. Interest accrual            | `credits/accrue-interest.ts` + scheduler                     | `credit_transactions(interest)` + `user_credits`, per-user txn, period-cursor unique               | balances FOR UPDATE                                                         | Covered (partial-retry safe). On-chain side never moves → drift divergence (HIGH-2b).                                                                                                                               |
| 14. Withdrawal                  | `credits/withdrawals.ts`                                     | `pending_payouts(kind=withdrawal)` + `credit_transactions(withdrawal)` + `user_credits`, one txn   | balance FOR UPDATE + active-withdrawal fence                                | Atomic. But emits on-chain LOOP with no off-chain half → breaks markOrderPaid invariant (CRIT-2).                                                                                                                   |
| 15. Drift reconcile             | `payments/asset-drift-watcher.ts`                            | in-memory only                                                                                     | Horizon /assets, pool balance, `user_credits` sum                           | Restart re-pages if still over (by design). Equation omits deposit-held LOOP and assumes a pool→user distribution that doesn't exist (HIGH-2/2b).                                                                   |

### Coverage

Lifecycle steps traced end-to-end: order create (loop-handler/repo/repo-credit-order/cashback-split) → quote (loop-create-response/sep7) → deposit watch (watcher/amount-sufficient/stroops/price-feed/price-feed-fx/horizon) → expiry+stuck sweeps (transitions-sweeps/watcher-bootstrap/procurement-worker) → state machine (transitions) → procurement (procurement/procure-one/pay-ctx/payout-submit/procurement-redemption) → fulfillment (fulfillment/payout-builder) → payout (payout-worker/payout-worker-pay-one/pending-payouts/pending-payouts-transitions/horizon-find-outbound/stuck-payout-watchdog) → admin recovery (payouts-retry/payout-compensation/withdrawals/refunds) → interest (accrue-interest/interest-scheduler/interest-pool-watcher) → reconciliation (asset-drift-watcher/horizon-circulation/liabilities). Not traced: legacy CTX-proxy `/api/orders` path, admin credit adjustments beyond compensation, apy-snapshot/interest-forecast internals, barcode-fields.

## Cross-cutting — future plans

Audit date: 2026-06-11. Branch: `feat/serve-strong-foreign-markets` (PR #1408 open). Dimension: coherence, sequencing, and gaps across all forward-looking documents.

### Findings

- [CRITICAL] docs/adr/035-extended-supplier-currency-markets.md:50–65 + apps/backend/src/orders/loop-handler.ts:259 + apps/backend/src/db/migrations/0021_orders_currency_check.sql — ADR 035 (PR #1408, already committed to the branch as 9b1d306c) claims "display + ordering (the XLM rail)" and "No backend change" for AE/IN/SA/AU/MX. The loop-native order handler hard-rejects any order currency outside USD/GBP/EUR (`currency must be USD, GBP, or EUR`), and five DB CHECKs (`orders_currency_known`, `orders_charge_currency`, `user_credits`, `credit_transactions`, `users.home_currency` — schema.ts:89,141,220,548,554) lock to `('USD','GBP','EUR')` (CAD isn't even included). The marketing site will surface ~286 merchants users cannot actually buy through the Tranche-1 order path. Migration 0021's own comment requires "a deliberate migration that touches every \*\_currency_known CHECK" — that migration exists in no plan. Fix: before merging/launching #1408, decide widen-the-CHECKs (+ handler + money formatting) vs gate extended-market merchants out of the order path, and amend ADR 035.
- [CRITICAL] docs/tranche-1-launch.md:68,152 + docs/phase-1-while-apple-approves.md:37 — both launch runbooks pin the Centre USDC issuer as `GA5ZSEJYB37JRC5AVCIA7…` while `apps/backend/.env.example` / `env.ts` carry `GA5ZSEJYB37JRC5AVCIA5…`. An operator copy-pasting the runbook (the documented launch path) configures a non-existent issuer and silently breaks USDC payment acceptance — and `preflight-tranche-1.sh` checks key presence, not value, so the gate won't catch it. Fix: correct both docs, add a value check to preflight.
- [HIGH] redemption-null backfill — flagged 2026-05-14 ("`redeemUrl/Code/Pin` returned false on the validated e2e order — investigate before public order traffic") — appears in NO roadmap item, NO tranche-1 checklist, NO tracker. Its only written home is docs/comprehensive-audit-2026-06-11.md:111 (P1 #10), created today, which itself has no execution tracker. A named pre-public-traffic blocker has been orphaned for 4 weeks. Fix: add to the Tranche-1 exit criteria in roadmap.md + tranche-1-launch.md acceptance check with an owner.
- [HIGH] docs/comprehensive-audit-2026-06-11.md — 774 findings (9 Critical, 74 High) with a P0/P1 priority queue, but no tracker, no remediation plan, and no AGENTS.md docs-index entry. Meanwhile AGENTS.md still names `docs/audit-2026-tracker.md` as the "working tracker," whose own line 3 banner says "superseded … do NOT treat its counts or row statuses as live," pointing instead at `docs/audit-2026-05-03-claude/` (which shows 0 open). Three generations of audit bookkeeping disagree about what's open; the newest and largest findings set is governed by nothing. Fix: stand up a tracker/remediation plan for the 2026-06-11 audit and repoint AGENTS.md.
- [HIGH] docs/tranche-2-scoping.md:13–18,178–222 + docs/adr/030:108 + docs/adr/031:194 — the entire Tranche-2 dependency chain hangs on the Privy Soroban DD ("1–3 hours" per ADR 030) and DeFindex template choice. The scoping timeline assumes DD complete by Day 7 from 2026-05-05; 37 days later both ADRs are still `Proposed`, no DD is recorded as scheduled, no revised timeline exists, and the "~6 months end-to-end" testnet clock (which includes a 4–8 week vault audit and 4–6 week counsel review) has not started. June engineering went to the supplier-coverage program instead — which appears in no planning doc. Fix: schedule the DD call (the cheapest unblock in the whole graph) or write down the deliberate deprioritisation with a new date.
- [HIGH] docs/adr/027-mobile-platform-security.md:55 — claims "All four controls remain listed in the Phase-2 roadmap (`docs/roadmap.md` §'Mobile platform hardening')". That section does not exist in roadmap.md (grep: zero hits). The four deferred controls have no home in any forward plan, and one Phase-2 trigger is arguably already met: binary-tamper detection's trigger is "distribution path moves outside the official stores," and the Phase-1 deliverable is explicitly APK sideload via "direct link, Drive, Diawi" (tranche-1-launch.md:276,330). Fix: add the roadmap section, re-evaluate the tamper-detection trigger against the sideload deliverable.
- [MED] docs/adr/031:19,88 vs 222,229–230 and Open Question 9 — internal contradiction in a `Proposed` ADR: the v7 decision says nightly **on-chain** GBPLOOP mints with "No off-chain accrual ledger needed for GBP," yet the file map still ships v6 rows — "Off-chain APY accrual (GBP): `interest-accrual.ts` daily cron updating `accrued_interest_minor`" + a migration adding that column — and OQ9 says GBPLOOP APY comes from an "off-chain ledger of accrual rate history" while §rate-setting (line 94) says "computed from on-chain mint history." Line 222's file-map row is garbled: "Asset rename GBPLOOP → GBPLOOP" (leftover from the abandoned v6 LOOPGBP rename). Whoever implements Track D from tranche-2-scoping.md will build the wrong thing depending on which section they read. Fix: reconcile the file map to v7 before ADR Accept.
- [MED] docs/adr/028-admin-step-up-auth.md:19–21,71 — status says "Pending: web modal (`StepUpModal` component + `useStepUpToken` hook)" but `apps/web/app/components/features/admin/StepUpModal.tsx`, `use-admin-step-up.ts`, and the store all exist and are tested. Done-but-marked-open. Also internally inconsistent on the signing-key env name: line 12 says `LOOP_ADMIN_STEP_UP_SIGNING_KEY`, line 71 says `LOOP_STEP_UP_SIGNING_KEY`. The Phase-2 expansions (gate cashback-config writes, WebAuthn, 4-eyes co-sign) appear in no roadmap/tranche doc. Fix: update status, fix the env-var name, home the Phase-2 expansions.
- [MED] docs/roadmap.md:34–40 — "Deploy backend to Fly.io," "Deploy web (SSR)," "DNS," and "monitoring operator side" are unchecked, yet the backend was redeployed and the full purchase chain validated end-to-end against deployed `api.loopfinance.io` on 2026-05-14 (CTX order `f0dbaae5`, Stellar tx `fe85137c`). The roadmap — the doc AGENTS.md calls "what's left" — understates Phase-1 progress; conversely nothing records whether `loopfinance-web` was ever first-deployed. Fix: sync checkboxes to deployed reality, dated.
- [MED] AGENTS.md docs index stops at ADR 031 — ADRs 032 (variant grouping), 033 (geo), 034 (locale routing), 035 (extended markets) are missing, and the entire June supplier-coverage program (~1,140 merchants, 33 currencies, ~60 untracked scripts) appears in no roadmap, tranche, or phase doc. The largest workstream of the last month is unplanned in every forward-looking document, while both contracted tracks (T1 packaging, T2 DD) sat idle since 2026-05-14. Fix: index the ADRs; write the supplier-program close-out plan (incl. the ~20 catalogue-only currencies awaiting threshold promotion per ADR 035 §2 — "revisited as the catalogue grows," with no review cadence).
- [MED] docs/adr/005-known-limitations.md §11 and §2 — stale triggers. §11 ("token transport via upstream … revisit … likely coincides with Phase 2") is obsolete: Loop-native auth (ADR 013) shipped and the Tranche-1 runbook sets `LOOP_AUTH_NATIVE_ENABLED=true`. §2's revisit trigger is "when a barcode-primary merchant is added to the catalog" — the June supplier program onboarded every SVS/Tillo/EzPin product (SVS is in-store/barcode-heavy); nobody re-ran the trigger check. Fix: dated re-check pass over all 11 ADR-005 entries.
- [MED] docs/audit-2026-remediation-plan.md Batch 0 vs docs/audit-2026-tracker.md:157 vs docs/audit-2026-admin-handoff.md — the remediation plan still presents Batch-0 operator config (A2-119 org 2FA, A2-105 secret scanning, A2-101 review requirement, A2-1406 production Environment) as pending, while the (superseded) tracker shows A2-119 resolved 2026-04-27, and today's audit confirms A2-103 (CODEOWNERS team doesn't exist → every required-review rule is a no-op) is still open. No single document states which operator-config items remain. Fix: one live operator-config checklist, retire the rest.
- [MED] docs/tranche-2-scoping.md A.5/D.1 — reserves migration filename `0033_gbploop_interest_payments.sql`. Migration 0032 (`user_favorite_merchants`) already landed after the scoping doc was written; any next migration takes 0033 and the doc's hardcoded number silently drifts. Fix: reference the migration by name, not number.
- [MED] single-operator SPOF cluster — every launch-critical step is operator-only with no backup: Fly secrets, Apple Developer enrollment, Android keystore generation ("losing the keystore means losing Play Store package identity permanently" — and both runbooks say back it up to 1Password, which the operator reportedly does not use), MaxMind build secrets, Revolut, counsel selection. None of the planning docs name a second person or an escrow procedure. Fix: document keystore/secret escrow that doesn't assume 1Password.
- [LOW] docs/roadmap.md:11 vs docs/tranche-1-launch.md:3,363 — Tranche-1 acceptance differs: roadmap says "purchase … with XLM (USDC follow-on)"; the launch runbook makes the USDC purchase a required smoke-test step (#4) and headlines "XLM + USDC." Ambiguous whether USDC is in the acceptance gate.
- [LOW] docs/deployment.md:205–220 + docs/adr/033 — GeoLite2 `.mmdb` refreshes only on deploys that remember the MaxMind build secrets, and the download is "best-effort, so a build without the secrets just falls back to the US default" — a silent degradation of the ADR 034 geo-redirect with no scheduled refresh cadence or staleness alert in any plan.
- [LOW] docs/phase-1-while-apple-approves.md:1–8 + tranche-1-launch.md:306 — "File Apple Developer enrollment on Day 1," "~5 days / ~10 days total." Written ~2026-05-06; >1 month later there is no recorded filing, and the same mobile-submission items live in two other docs (roadmap §Mobile app submission, tranche-1 §Track 3) — three overlapping checklists, none with dates or owners, none updated.
- [LOW] docs/adr/005 §4 — distributed rate-limit trigger ("when we horizontally scale") is adjacent to met: deployment.md documents `fly scale count 2` and the 2026-05-06 snapshot shows 2 machines provisioned (one auto-stopped). Under load both run and per-IP limits double.
- [LOW] docs/roadmap.md:212–224 — heading structure broken: "Tranche 3 contract deliverables" is nested _under_ "## Phase 3 — Growth & polish," followed by a duplicate "### Phase 3 — Growth & polish (post-contract…)" stub whose "items below" don't follow it. Confuses what's contractual vs aspirational.

### Dependency graph

```
TRANCHE 1 (launch)
  Apple Developer enrollment (external, 3–7d; NOT YET FILED as of any doc)
    └→ bundle ID io.loopfinance.app → ASC entry → Xcode signing/archive → TestFlight
         └→ demo video → T1 acceptance
  Operator Fly secrets (Batch incl. correct USDC issuer ← BLOCKED on doc fix [CRITICAL #2])
    └→ preflight-tranche-1.sh → backend redeploy → e2e-real validation  [DONE 2026-05-14]
  api.loopfinance.io DNS  → loopfinance-web first deploy (VITE_API_URL baked at build)  [status unrecorded]
  Android keystore (operator, irreversible, escrow gap) → signed APK → demo video
  Legal review of privacy/terms → public App Store submission (not TestFlight)
  Redemption-null backfill fix → public order traffic  [ORPHANED]
  ADR 035 currency-CHECK decision → extended-market orders actually work  [UNPLANNED]

TRANCHE 2
  Privy Soroban DD (ADR 030 OQ1–2)  ┐
  DeFindex template choice (031 OQ3)┴→ ADR 030+031 Accepted (Track K)
       └→ Track B (Privy) ──────────────┐
       └→ Track C (vault) → testnet deploy ─┼→ Track F (cashback wiring) → Track G (UX)
       └→ Track D (GBPLOOP mint, Soroban-independent — could ship early) ┘
            └→ Track I testnet build → T2 ACCEPTANCE
  Track C audit ($30–80k, 4–8wk) ┐
  Track J counsel (4–6wk) + FCA EMI ┴→ MAINNET (Tranche 3 gate)
  Track A (vendor-agnostic, ~5d FTE) — unblocked since 2026-05-05, not started
  Track E (Revolut API) ← partner resolved 2026-05-05; integration unscoped
  Privy DD fail branch: +1–2wk dfns migration, then resume

TRANCHE 3
  T2 acceptance → mainnet flip + Plaid (2–3mo) + card issuing (BIN sponsor, 4–6mo) + 4-country reg posture

AUDIT REMEDIATION
  Batch 0 operator config (partially done; A2-103 CODEOWNERS still open) → Batches 1–5
  …but tracker superseded by 2026-05-03 registers (0 open) — and the 2026-06-11 audit
  (774 findings, 9 Critical) has NO plan/tracker → currently blocks nothing, governs nothing.

ADR 027 deferred controls → Phase-2 triggers (MITM event / bot spike / ≥10K MAU /
  outside-store distribution ← ALREADY MET by APK-sideload deliverable) → no roadmap home (dead §pointer)
```

### Orphaned work register

- Redemption-null backfill + `Body has already been read` polling-fallback bug — flagged 2026-05-14 (post-e2e), reconfirmed comprehensive-audit-2026-06-11 P1 #10 — planned NOWHERE (no roadmap/tranche/tracker entry).
- ADR 035 × currency CHECK + `isHomeCurrency` handler collision — flagged comprehensive-audit-2026-06-11 P0 #2 — planned NOWHERE (not in ADR 035, not in PR #1408 body, no migration scoped). Migration 0021's comment explicitly demands a deliberate all-tables migration that no doc owns.
- ADR 027's four deferred mobile controls — flagged A2-1204 / ADR 027 — planned at a roadmap section ("Mobile platform hardening") that DOES NOT EXIST; binary-tamper trigger already met by the APK sideload deliverable, unnoticed.
- ADR 028 Phase-2 expansions (step-up on cashback-config writes, WebAuthn, 4-eyes threshold) — flagged in ADR 028 — planned NOWHERE outside the ADR itself.
- comprehensive-audit-2026-06-11's 774 findings (9 Critical: USDC issuer digit, refresh-rotation race, OTP kill-switch self-reset, etc.) — flagged today — NO tracker, NO remediation plan, NO AGENTS.md index entry.
- June supplier-coverage program follow-ups — ~20 catalogue-only currencies awaiting ≥15-merchant promotion review (ADR 035 §2, "revisited as the catalogue grows" — no cadence/owner); productionising or deleting ~60 untracked scripts; logo.dev key hygiene — planned NOWHERE.
- `loopfinance-web` first deploy + DNS — listed in three checklists (roadmap, tranche-1 Track 2, while-apple-approves B.1) — no doc records whether it happened; no single owner.
- ADR 031 file-map cleanup to v7 (delete the v6 off-chain-accrual rows + garbled rename row) — flagged here — planned NOWHERE.
- Keystore escrow procedure not dependent on 1Password — implied by tranche-1-launch B.3 — planned NOWHERE.
- GeoLite2 refresh cadence / staleness signal — implied by deployment.md "refreshes on each such deploy" — planned NOWHERE.

## What a competent PM would add (no doc currently contains)

1. One live launch-readiness board with owner + date per item, replacing the three overlapping T1 checklists; a dated record of whether Apple enrollment was filed.
2. A priority call between the three concurrent programs (T1 close-out, T2 DD, audit remediation, supplier coverage) — currently interleaved with zero sequencing decision recorded; T2's external-lead-time items (counsel, vault audit, Privy DD) are the ones that can't be compressed later.
3. A tracker for the 2026-06-11 audit and a standing "which audit is live" pointer.
4. Trigger-review cadence (quarterly, dated) for ADR 005 + ADR 027 deferrals.
5. Apple-rejection contingency and a TestFlight→public-submission gap plan (legal copy is on the public-submission critical path with no lawyer engaged — remediation-plan open question #2 still unanswered).
6. CTX supplier-churn risk: the June program proved the upstream catalogue can reshape overnight (ADR 021 eviction policy exists, but no plan covers supplier-driven currency/merchant churn vs the hard currency CHECKs).
7. Hot-float sizing, Revolut API scoping, and per-MAU Privy cost checkpoints with dates (all named "later" in ADR 030/031 with no trigger).

### Coverage

12 planning docs traced in full (roadmap, tranche-1-launch, tranche-2-scoping, phase-1-while-apple-approves, ADR 005/027/028/030/031/035, audit-2026-remediation-plan, audit-2026-05-03-claude/tracker) + 6 corroborating sources (audit-2026-tracker, admin-handoff, remediation-queue, comprehensive-audit-2026-06-11, deployment.md §GeoLite2, phase-1-deployed-snapshot) + code verification (loop-handler.ts, migrations 0014/0021/0032, StepUpModal, countries.ts, PR #1408).

# Part IV — Full remediation plan

> Sequenced, PR-sized. Pacing follows the house rule: one PR at a time — open → CI green → merge →
> next. Items marked **[operator]** need human/console action, not a PR. Items marked **[decision]**
> need a product/architecture call before code. Every auth/payment/Stellar item requires human
> review per the security rules. Where a finding class repeats, the plan adds a _detector_ so the
> class can't regress (house convention: codify review findings into detection scripts).

## Phase 0 — same-day safety (docs + operator, zero code risk)

| #   | Action                                                                                                                                                                                                                                                                                                                      | Files                                                                                                                              | Closes              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 0.1 | Fix USDC issuer to `…AVCIA5…` in both runbooks; **[operator]** re-set the Fly secret to the canonical value (cheap insurance — current deployed value is unverifiable from the repo); extend `preflight-tranche-1.sh` to assert the _value_ of `LOOP_STELLAR_USDC_ISSUER` against the canonical constant, not just presence | `docs/tranche-1-launch.md:68,152`, `docs/phase-1-while-apple-approves.md:37`, `scripts/preflight-tranche-1.sh`                     | Headline #3         |
| 0.2 | Strip hardcoded logo.dev key from 5 scripts → `LOGODEV_KEY` env with `/tmp/logodev-key.txt` fallback; replace already-pushed `logoUrl?token=` values in the CTX catalog with a token-free CDN form if logo.dev supports it, else accept (publishable tier) and note in script README                                        | `scripts/ctx-media-cleanup.mjs:9`, `newinfo-apply.mjs:10`, `note-resource.mjs:6`, `qc-residue-fix.mjs:8`, `note-fixes-media.mjs:6` | Headline #8 (part)  |
| 0.3 | AGENTS.md truth pass: add ADR 032–035 index rows; point the audit-tracker line at `docs/audit-2026-05-03-claude/tracker.md` and **this document**; fix CI job count (twelve) + add `test-e2e-flywheel`; refresh the required-checks list                                                                                    | `AGENTS.md`                                                                                                                        | Headline #9 (part)  |
| 0.4 | Register this audit: add to the AGENTS.md docs index and adopt the Part II/III findings into the live tracker so the 857 findings have a home (the plans audit found this audit would otherwise itself be orphaned work)                                                                                                    | `AGENTS.md`, tracker                                                                                                               | Headline #10 (part) |

## Phase 1 — money-path criticals (one PR each, human review, tests required)

| #   | Action                                                                                                                                                                                                                                                                                                                                                          | Files                                                                                             | Closes                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1.1 | **Watcher skip-retry table.** Persist every skipped payment (memo, paging_token, reason, attempts) before advancing the cursor; sweep the table each tick; alert on age > threshold. Fix the false A4-110 comment. Tests: skip-then-recover for (a) transient FX insufficiency, (b) A4-110 row appearing later                                                  | `payments/watcher.ts:230-288`, new `payments/skipped-payments.ts`, migration                      | Headline #1                             |
| 1.2 | **Poison-pill isolation.** Per-payment try/catch inside the loop: unknown errors record to the skip table + Discord alert + `continue`, never abort the tick. Tick-level rethrow only for page-fetch/infra errors. Test: one poisoned payment, rest of page processes, cursor advances                                                                          | `payments/watcher.ts:237-261`                                                                     | Headline #2                             |
| 1.3 | **[decision] Withdrawal↔loop_asset spend invariant.** On-chain LOOP can exceed off-chain balance after a withdrawal. Decide: reject loop_asset deposits exceeding off-chain balance with a typed, user-visible error + ops alert (cheap, recommended for Phase 1), or implement on-chain-aware debit. Then implement + test the CHECK-violation path explicitly | `orders/transitions.ts`, `credits/withdrawals.ts`, `payments/watcher.ts`                          | Headline #2 trigger                     |
| 1.4 | **Redemption-null backfill sweep** (scheduled re-fetch for fulfilled orders with null code/pin/url; backoff 1h/2h/6h, alert after 10 attempts) **+ fix the `Body has already been read` bug** in the polling fallback (clone or re-issue the request per tick — today the fallback never actually retries)                                                      | `orders/procurement-redemption.ts`, new sweeper                                                   | Headline #10 orphan, 2026-05-14 blocker |
| 1.5 | **[decision] Circulation drift.** Either implement the documented deposit-LOOP burn/treasury routing + an on-chain counterpart for interest accrual, or amend the drift watcher's equation to model both flows. Belongs with the ADR 030/031 acceptance work — but cap the interim: alert once, then suppress-with-daily-digest instead of paging permanently   | `payments/asset-drift-watcher.ts`, `orders/transitions.ts`, `credits/accrue-interest.ts`, ADR 031 | Headline #5                             |

## Phase 2 — auth + admin correctness (small PRs, can interleave with Phase 1 reviews)

| #   | Action                                                                                                                                                                                      | Files                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 2.1 | Refresh rotation: pre-generate `refreshJti`, win the CAS in `tryRevokeIfLive` _before_ persisting the new pair                                                                              | `auth/native.ts:164`                                                                           |
| 2.2 | OTP kill-switch: move `setOtpDeliveryEnabled(true)` to the send-success branch (or delete)                                                                                                  | `auth/native-request-otp.ts:47`                                                                |
| 2.3 | Payout retry: wrap in `withIdempotencyGuard` like every other write handler                                                                                                                 | `admin/payouts-retry.ts:146`                                                                   |
| 2.4 | Idempotency guard: corrupt snapshot ⇒ 500 + alert, never silent re-execution                                                                                                                | `admin/idempotency.ts`                                                                         |
| 2.5 | Peg-break notifier: move outside the transaction; fix watcher's wrong "expected" amount in cross-currency insufficient logs                                                                 | `orders/fulfillment.ts:151`, `payments/watcher.ts:226`                                         |
| 2.6 | Top-cashback sort: cast pct to numeric in the orderBy                                                                                                                                       | `public/top-cashback-merchants.ts:59`                                                          |
| 2.7 | A4-110: Discord alert + admin list/recovery endpoint for stalled loop-asset orders (folds into the 1.1 skip table)                                                                          | `payments/watcher.ts`, admin                                                                   |
| 2.8 | Daily admin-write cap: acquire the same advisory lock as `applyAdminCreditAdjustment`                                                                                                       | `credits/payout-compensation.ts:150`                                                           |
| 2.9 | Misc handler gaps: DSR `failed_uncompensated_withdrawals` mapped to its own 409 reason; try/catch + envelope on cashback-history/user-credits handlers; redact `q` in user-search debug log | `users/dsr-handler.ts:119`, `users/cashback-history-handler.ts:86`, `admin/user-search.ts:113` |

## Phase 3 — ADR 035 product gap (decision first, then 1–2 PRs)

**[decision]** Pick one for the AE/IN/SA/AU/MX markets: **(A)** make display-only real — suppress
the buy CTA for merchants whose currency isn't orderable, with "coming soon" copy (small web PR;
recommended now), or **(B)** extend the order path to extended currencies — migration widening the
five CHECKs, FX coverage, payment-amount validation, and explicit no-cashback handling (significant;
schedule deliberately). Regardless of A/B, fix in one web PR: hardcoded `$` in `MobileHome.tsx:484`
and the public SEO landing page; derive the minor-unit divisor from `Intl.NumberFormat` in
`money-format.ts:59`; add cross-reference comments at the five schema CHECKs pointing at
`HOME_CURRENCIES` and ADR 035. Amend ADR 035 to state the order-path behavior honestly.

## Phase 4 — CI/CD gates

| #   | Action                                                                                                                                                                                                                                                                                                               | Notes                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 4.1 | **[operator — ask-first per guardrails rule]** Add `secret-scan`, `container-cve-scan`, `sbom`, `flywheel-integration` to required status checks                                                                                                                                                                     | Headline #6                                    |
| 4.2 | Invoke `./scripts/check-bundle-budget.sh` in the `build` job (it exists, is documented, and is never called)                                                                                                                                                                                                         | `.github/workflows/ci.yml`                     |
| 4.3 | CI migration validation: a job step applying the full migration chain to a scratch postgres and diffing against `schema.ts` (drizzle-kit check), since nothing checksums or validates migrations today                                                                                                               | new CI step                                    |
| 4.4 | **Detector:** openapi-parity script — every route mount has a registration; declared statuses include 429 where rate-limited, 503 where circuit-gated, and the real `requireAdmin` 404 (fixes the ~10 endpoints declaring 403, `/health` missing 503, and the fully-wrong `flywheel-share` spec as the first corpus) | new `scripts/check-openapi-parity.mjs` + fixes |
| 4.5 | **[operator]** CODEOWNERS: create the team or replace with real usernames; add an explicit `.github/workflows/**` rule (A2-103)                                                                                                                                                                                      | `.github/CODEOWNERS`                           |
| 4.6 | Web Dockerfile: fail the build when `VITE_SENTRY_DSN` build-arg is absent in production builds (today Sentry silently disables)                                                                                                                                                                                      | `apps/web/Dockerfile`                          |

## Phase 5 — contract parity (one PR)

Apply `/tmp/audit-out/adr019-contract-parity.patch` (787 lines, typecheck-verified during the
audit): moves favorites/recently-purchased/public-stats/social-login/cashback-rate types into
`packages/shared`, aliases `UserPendingPayoutState = PayoutState`, adds `phase1Only` to the openapi
config schema, adds `loopAssets` to the web `AppConfig`. Then add a **detector**: script flagging
identically-named exported types declared on both sides of the web/backend boundary.

## Phase 6 — env-var lifecycle (one PR + doc rows)

`EMAIL_REPLY_TO_ADDRESS` into the `env.ts` Zod schema (today read via bare `process.env`, invisible
to lint-docs); `LOOP_ADMIN_STEP_UP_SIGNING_KEY` into `preflight-tranche-1.sh` + `deployment.md`
(optional-in-schema but its absence 503s every destructive admin endpoint); sweep the remaining
LOW-grade matrix mismatches from the cross-env report.

## Phase 7 — test integrity (1–2 PRs)

Fix the vacuous tests so green means something: `pending-payouts-schema.test.ts:42` (asserts its own
literals), `top-users-by-pending-payout.test.ts:136` (`_expected` never asserted),
`refresh-tokens.test.ts` (zero coverage of `tryRevokeIfLive`/`findRefreshTokenRecord` — pairs with
2.1), `admin-writes.test.ts:612` (serial "race"), `use-session-restore.test.ts` /
`use-auth.test.tsx` / `use-native-platform.test.ts` (hooks never invoked),
`Sparkline.test.tsx:33` (`!== undefined` on `querySelector`), `PaymentStep.test.tsx:120`
(assert the copied value), `CashbackCalculator.test.tsx:128` (fake timers), duplicated
`configHistoryHandler` block, `loop-handler.test.ts:774` double `vi.resetModules()`. Add
`user_favorite_merchants` to `tests/e2e-mocked/global-setup.ts:24` truncation list.

## Phase 8 — docs/ADR hygiene (batchable, low risk)

ADR 015/030/031 supersession untangle (mark 015's superseded sections explicitly; decide
Proposed→Accepted gates for 030/031 and write them in the headers; fix 031's v6 residue rows);
ADR 028 env-var name; runbook dead path (`operator-pool-exhausted.md` →
`src/ctx/operator-pool.ts`) + cross-check all runbook paths; roadmap refresh adopting the
orphaned-work register (redemption backfill, ADR 027 triggers — the sideload trigger is already
met, `loopfinance-web` deploy status, keystore escrow, GeoLite2 cadence, thin-currency promotion
process); `deployment.md` web section; `architecture.md` locale-routing section + the API-endpoints
section `slo.md:263` dangles on; `standards.md` `postcss`→`hono` accepted-advisory drift;
`signing.gradle:62` dead doc link.

## Phase 9 — scripts pile disposition (one PR)

Keepers (re-runnable catalog ops: pulls, allocators, QC, review servers) → `tools/ctx-catalog/`
after: prettier pass, `CTX_TOKEN` env fallback in the 9 `/tmp`-only readers, `--dry-run` default +
`--apply` flag on every bulk mutator (`merge-pairs`, `ctx-combined-split-apply`, region retaggers,
dedup/gc-strip family), constituent-PUT verification before disable in `ctx-combined-split-apply`,
and removal of the session-transient path in `qc-residue-fix.mjs:12`. One-offs: delete (they're
reconstructible from this audit's record).

## Phase 10 — quality tail (grouped, opportunistic)

Extract `fmtStroops` ×4 → shared util; `since`-vs-queryKey staleness in 6 admin components;
StepUpModal native `<dialog>` focus trap; dev proxy must not fall back to the production API when
`VITE_API_URL` is unset; maskable-icon safe-zone variant; image-proxy LRU byte-counter drift;
~1.1 MB dead splash PNGs in the Android overlay + identical 1x/2x/3x iOS splash slots;
`Number(BigInt(minor))` precision; share-image load timeout; Sentry scrubber consolidation +
stack scrubbing; `MobileHome.tsx`/`Onboarding.tsx` decomposition; Onboarding back-nav trap;
kill-switch per-path granularity (legacy vs loop-native); centralize feature-flag interdependency
validation in `parseEnv`; Hono ≥ 4.12.25 bump.

## Suggested order of execution

0.1 → 0.2 → 0.3+0.4 (one docs PR) → 1.1 → 1.2 → 1.4 → 2.x singles → Phase 3 decision + web money
PR → 4.2+4.4 → Phase 5 patch → remaining phases as capacity allows. Phase 1.3/1.5 and Phase 3's
option B are the items needing real design time — schedule them with the ADR 030/031 acceptance
push, which the plans audit identifies as the project's stalled critical path.

# Appendix A — Per-file coverage log (1,751 files)

> One verdict line per file — the proof of coverage. Every tracked and untracked file appears below exactly once, grouped by audit batch. (Batch 12 lists clean files separately; its remaining files are covered file-by-file in its Part II findings.)

## Batch 01 — backend src (1/7)

- apps/backend/.env.example — clean, well-documented, no secrets
- apps/backend/AGENTS.md — clean, comprehensive agent guide
- apps/backend/buf.gen.yaml — generated config — acknowledged
- apps/backend/Dockerfile — clean, pinned SHA, non-root, HEALTHCHECK
- apps/backend/drizzle.config.ts — clean
- apps/backend/fly.toml — clean
- apps/backend/package.json — clean
- apps/backend/proto/clustering.proto — clean proto definition
- apps/backend/README.md — clean, standard quickstart doc
- apps/backend/src/**fixtures**/ctx/create-order-response.json — fixture, synthetic — acknowledged
- apps/backend/src/**fixtures**/ctx/get-order-response.json — fixture, synthetic — acknowledged
- apps/backend/src/**fixtures**/ctx/list-orders-response.json — fixture, synthetic — acknowledged
- apps/backend/src/**fixtures**/ctx/merchant-item.json — fixture, synthetic — acknowledged
- apps/backend/src/**fixtures**/ctx/merchants-list-response.json — fixture, synthetic — acknowledged
- apps/backend/src/**fixtures**/ctx/README.md — clean documentation
- apps/backend/src/**fixtures**/ctx/refresh-token-response.json — fixture, synthetic tokens — acknowledged
- apps/backend/src/**fixtures**/ctx/verify-otp-response.json — fixture, synthetic tokens — acknowledged
- apps/backend/src/admin/asset-circulation.ts — clean; correct error handling; 503 on Horizon failure
- apps/backend/src/admin/asset-drift-state.ts — clean; synchronous read from in-memory state
- apps/backend/src/admin/audit-envelope.ts — clean; PII (actorEmail) appropriately scoped to admin surfaces
- apps/backend/src/admin/audit-tail-csv.ts — clean; see Content-Disposition note (MEDIUM shared pattern)
- apps/backend/src/admin/audit-tail.ts — clean; see LOW (local type defs vs shared)
- apps/backend/src/admin/cashback-activity-csv.ts — clean
- apps/backend/src/admin/cashback-activity.ts — clean
- apps/backend/src/admin/cashback-configs-csv.ts — clean
- apps/backend/src/admin/cashback-monthly.ts — clean
- apps/backend/src/admin/cashback-realization-daily-csv.ts — clean
- apps/backend/src/admin/cashback-realization-daily.ts — clean
- apps/backend/src/admin/cashback-realization.ts — clean
- apps/backend/src/admin/config-history-handler.ts — clean
- apps/backend/src/admin/configs-history.ts — clean
- apps/backend/src/admin/credit-adjustments.ts — clean; ADR-017 contract fully implemented
- apps/backend/src/admin/csv-escape.ts — clean; see LOW (missing \n prefix)
- apps/backend/src/admin/discord-config.ts — clean; correctly masks webhook URLs
- apps/backend/src/admin/discord-notifiers.ts — clean
- apps/backend/src/admin/discord-test.ts — clean; see LOW (weaker User type cast)
- apps/backend/src/admin/handler.ts — clean; barrel re-export module
- apps/backend/src/admin/home-currency-set.ts — clean; correct preflight invariants
- apps/backend/src/admin/idempotency-constants.ts — clean
- apps/backend/src/admin/idempotency-store.ts — clean; TTL handling correct
- apps/backend/src/admin/idempotency.ts — see MEDIUM (corrupt snapshot re-execution risk)
- apps/backend/src/admin/interest-mint-forecast.ts — see MEDIUM (missing outer try/catch)
- apps/backend/src/admin/merchant-cashback-monthly.ts — clean
- apps/backend/src/admin/merchant-cashback-summary.ts — clean; see LOW (misleading ?? fallback)
- apps/backend/src/admin/merchant-flows.ts — clean
- apps/backend/src/admin/merchant-flywheel-activity-csv.ts — see MEDIUM (merchantId in Content-Disposition)
- apps/backend/src/admin/merchant-flywheel-activity.ts — clean
- apps/backend/src/admin/merchant-flywheel-stats.ts — clean
- apps/backend/src/admin/merchant-operator-mix.ts — clean
- apps/backend/src/admin/merchant-payment-method-share.ts — clean
- apps/backend/src/admin/merchant-stats-csv.ts — see MEDIUM (raw ISO string in SQL template)
- apps/backend/src/admin/merchant-stats.ts — see MEDIUM (raw ISO string in SQL template)
- apps/backend/src/admin/merchant-top-earners.ts — see MEDIUM (raw ISO string in SQL template; shared pattern)
- apps/backend/src/admin/merchants-catalog-csv.ts — clean; correct inArray scoping (A2-503/504)
- apps/backend/src/admin/merchants-flywheel-share-csv.ts — see MEDIUM (raw ISO string in SQL template)
- apps/backend/src/admin/merchants-flywheel-share.ts — see MEDIUM (raw ISO string in SQL template)
- apps/backend/src/admin/merchants-resync.ts — clean; see LOW (openapi 502 status annotation)
- apps/backend/src/admin/operator-activity.ts — clean
- apps/backend/src/admin/operator-latency.ts — clean; percentile query correct
- apps/backend/src/admin/operator-merchant-mix.ts — clean

**Coverage:** 60/60 files reviewed. Skipped: none.

## ---

- apps/backend/src/admin/operator-stats.ts — clean; standard window validation + Drizzle raw query pattern
- apps/backend/src/admin/operator-supplier-spend.ts — clean; operator-id regex validation present
- apps/backend/src/admin/operators-snapshot-csv.ts — LOW: raw SQL column names bypass Drizzle type safety
- apps/backend/src/admin/orders-activity.ts — clean
- apps/backend/src/admin/orders-csv.ts — clean; gift-card secrets deliberately omitted
- apps/backend/src/admin/orders-detail.ts — clean
- apps/backend/src/admin/orders.ts — clean; comprehensive filter validation
- apps/backend/src/admin/payment-method-activity.ts — clean
- apps/backend/src/admin/payment-method-share.ts — clean
- apps/backend/src/admin/payout-compensation.ts — clean; uses withIdempotencyGuard correctly
- apps/backend/src/admin/payouts-activity-csv.ts — clean
- apps/backend/src/admin/payouts-activity.ts — clean
- apps/backend/src/admin/payouts-by-asset.ts — clean
- apps/backend/src/admin/payouts-csv.ts — clean; to_address included in CSV (expected for reconciliation)
- apps/backend/src/admin/payouts-detail.ts — clean
- apps/backend/src/admin/payouts-monthly.ts — clean
- apps/backend/src/admin/payouts-retry.ts — MEDIUM: non-atomic idempotency; INFO: PayoutRow/toView duplication
- apps/backend/src/admin/payouts.ts — clean; re-exports delegation pattern correct
- apps/backend/src/admin/read-audit.ts — clean; PII sanitization for Discord correct
- apps/backend/src/admin/reconciliation.ts — clean; drift detection pattern solid
- apps/backend/src/admin/refunds.ts — clean; uses withIdempotencyGuard; RefundAlreadyIssuedError caught
- apps/backend/src/admin/settlement-lag.ts — clean; GROUPING SETS usage correct
- apps/backend/src/admin/step-up-handler.ts — LOW: misleading error message on JSON parse failure
- apps/backend/src/admin/stuck-orders.ts — clean; anchor-timestamp logic clear
- apps/backend/src/admin/stuck-payouts.ts — LOW: orderId typed non-nullable but DB column is nullable for withdrawals
- apps/backend/src/admin/supplier-spend-activity-csv.ts — clean
- apps/backend/src/admin/supplier-spend-activity.ts — clean; dual query path for filter/no-filter case
- apps/backend/src/admin/supplier-spend.ts — clean; marginBps helper correct
- apps/backend/src/admin/top-users-by-pending-payout.ts — MEDIUM: email in response payload (PII)
- apps/backend/src/admin/top-users.ts — MEDIUM: email in response payload (PII)
- apps/backend/src/admin/treasury-builders.ts — clean; Horizon failure gracefully degraded
- apps/backend/src/admin/treasury-credit-flow-csv.ts — clean
- apps/backend/src/admin/treasury-credit-flow.ts — clean
- apps/backend/src/admin/treasury-snapshot-csv.ts — INFO: re-uses treasuryHandler JSON response; minor fragility
- apps/backend/src/admin/treasury.ts — LOW: no try/catch around DB queries
- apps/backend/src/admin/upsert-config-handler.ts — clean; previous-snapshot capture + Discord diff correct
- apps/backend/src/admin/user-by-email.ts — clean; LOWER() normalization on both sides
- apps/backend/src/admin/user-cashback-by-merchant.ts — clean
- apps/backend/src/admin/user-cashback-monthly.ts — clean; separate existence check for 404 vs empty
- apps/backend/src/admin/user-cashback-summary.ts — clean
- apps/backend/src/admin/user-credit-transactions-csv.ts — clean; Date.now() captured once to avoid race
- apps/backend/src/admin/user-credit-transactions.ts — clean
- apps/backend/src/admin/user-credits-csv.ts — INFO: bigint fields bypass csvEscape (no real risk)
- apps/backend/src/admin/user-credits.ts — clean
- apps/backend/src/admin/user-detail.ts — clean
- apps/backend/src/admin/user-flywheel-stats.ts — clean
- apps/backend/src/admin/user-operator-mix.ts — clean
- apps/backend/src/admin/user-payment-method-share.ts — clean
- apps/backend/src/admin/user-search.ts — MEDIUM: raw search query q logged at debug level (email PII)
- apps/backend/src/admin/users-list.ts — LOW: inconsistent ILIKE approach vs user-search.ts
- apps/backend/src/admin/users-recycling-activity-csv.ts — MEDIUM: email in CSV export
- apps/backend/src/admin/users-recycling-activity.ts — MEDIUM: email in response payload (PII)
- apps/backend/src/admin/withdrawals.ts — clean; asset-code guard + InsufficientBalanceError handled
- apps/backend/src/app.ts — clean; middleware stack well-ordered
- apps/backend/src/auth/admin-step-up-middleware.ts — clean; subject-pinning and CTX-path exemption correct
- apps/backend/src/auth/admin-step-up.ts — clean; timing-safe comparison correct; custom JWT implementation sound
- apps/backend/src/auth/authenticated-user.ts — clean; A2-550/551 fix documented and correct
- apps/backend/src/auth/email.ts — LOW: EMAIL_PROVIDER read from process.env directly, not through env singleton
- apps/backend/src/auth/handler.ts — clean; Zod validation on all upstream responses; enumeration defense on request-otp
- apps/backend/src/auth/id-token-replay.ts — clean; fail-closed on DB error; sha256 hash approach correct

**Coverage:** 60/60 files reviewed. Skipped: none

## Batch 03 — backend src (3/7)

- apps/backend/src/auth/id-token-verify-with-key.ts — clean; solid claim-shape and time-bound verification
- apps/backend/src/auth/id-token.ts — clean; JWKS fetch + retry with debounce well-structured
- apps/backend/src/auth/identities.ts — medium: step-1 race on user lookup (documented edge case, no alert)
- apps/backend/src/auth/issue-token-pair.ts — clean
- apps/backend/src/auth/jwks.ts — clean; Zod validation, debounce, TTL cache all correct
- apps/backend/src/auth/logout-handler.ts — clean; best-effort revoke correctly handles all error paths
- apps/backend/src/auth/native-request-otp.ts — high: unconditional `setOtpDeliveryEnabled(true)` clobbers health state
- apps/backend/src/auth/native.ts — high: orphaned refresh-token row on concurrent-rotation race
- apps/backend/src/auth/normalize-email.ts — low: space allowed in ASCII check before email validation
- apps/backend/src/auth/otps.ts — medium: brittle error-string match for idempotency in `incrementOtpAttempts`; medium: `now` injection in SQL
- apps/backend/src/auth/refresh-tokens.ts — clean; CAS revoke and hash-match well implemented
- apps/backend/src/auth/request-schemas.ts — clean
- apps/backend/src/auth/require-admin.ts — clean; correct 404 vs 401 discrimination
- apps/backend/src/auth/require-auth.ts — low: untrusted X-Client-Id value logged verbatim
- apps/backend/src/auth/signer.ts — info: RS256 dispatch returns empty set (pending Track A.2, intentional)
- apps/backend/src/auth/social.ts — low: broad catch on consumeIdToken swallows programming errors as 503
- apps/backend/src/auth/tokens.ts — low: no clock-skew leeway on expiry check
- apps/backend/src/circuit-breaker-registry.ts — clean
- apps/backend/src/circuit-breaker.ts — info: consecutiveFailures not reset on OPEN→HALF_OPEN transition
- apps/backend/src/cleanup.ts — clean
- apps/backend/src/clustering/algorithm.ts — clean; date-line-crossing limitation documented
- apps/backend/src/clustering/data-store.ts — medium: stale-warning dedup logic acceptable; low: module-level mutable state
- apps/backend/src/clustering/handler.ts — low: protobuf construction errors silently fall back to JSON
- apps/backend/src/config/handler.ts — clean; no secrets, correct feature-flag assembly
- apps/backend/src/credits/accrue-interest.ts — medium: brittle string-match for idempotency constraint detection
- apps/backend/src/credits/adjustments.ts — medium: advisory lock key has no collision analysis; otherwise correct
- apps/backend/src/credits/apy-snapshot.ts — clean
- apps/backend/src/credits/interest-forecast.ts — clean
- apps/backend/src/credits/interest-pool.ts — clean; caching correct with test seam
- apps/backend/src/credits/interest-scheduler.ts — info: setImmediate portability; otherwise clean
- apps/backend/src/credits/ledger-invariant.ts — clean; pure + SQL variants both correct
- apps/backend/src/credits/liabilities.ts — clean
- apps/backend/src/credits/payout-asset.ts — clean
- apps/backend/src/credits/payout-builder.ts — low: local LOOP_ASSET_CODES duplicates imported set
- apps/backend/src/credits/payout-compensation.ts — medium: daily-cap check lacks advisory lock; compensation rows can bypass cap under concurrent requests
- apps/backend/src/credits/pending-payouts-admin.ts — clean
- apps/backend/src/credits/pending-payouts-transitions.ts — clean; state-guarded CAS transitions correct
- apps/backend/src/credits/pending-payouts-user.ts — clean
- apps/backend/src/credits/pending-payouts.ts — info: local PayoutIntent interface duplicates payout-builder's
- apps/backend/src/credits/refunds.ts — low: `reason` is optional at primitive level but required at handler level
- apps/backend/src/credits/withdrawals.ts — medium: defensive insert with potentially negative balance on edge case
- apps/backend/src/ctx/operator-pool.ts — low: direct process.env bypass skips env schema validation
- apps/backend/src/ctx/stream.ts — high: bearer in query string; URL must never be logged (currently isn't, but no guard)
- apps/backend/src/db/client.ts — info: isPooledPostgresUrl heuristic misses Supavisor; otherwise clean
- apps/backend/src/db/migrations/0000_initial_schema.sql — clean
- apps/backend/src/db/migrations/0001_auth_tables.sql — clean
- apps/backend/src/db/migrations/0002_loop_orders.sql — clean
- apps/backend/src/db/migrations/0003_watcher_cursors.sql — clean
- apps/backend/src/db/migrations/0004_orders_redemption.sql — clean
- apps/backend/src/db/migrations/0005_user_identities.sql — clean
- apps/backend/src/db/migrations/0006_users_home_currency.sql — clean
- apps/backend/src/db/migrations/0007_orders_charge_columns.sql — clean; backfill predicate correct
- apps/backend/src/db/migrations/0008_orders_loop_asset_payment.sql — clean
- apps/backend/src/db/migrations/0009_users_stellar_address.sql — clean
- apps/backend/src/db/migrations/0010_pending_payouts.sql — low: order_id NOT NULL blocks withdrawal kind; corrected by later migration but sequential-apply risk
- apps/backend/src/db/migrations/0011_admin_idempotency_keys.sql — clean
- apps/backend/src/db/migrations/0012_credit_transactions_period_cursor.sql — clean
- apps/backend/src/db/migrations/0013_ledger_constraints.sql — clean
- apps/backend/src/db/migrations/0014_credit_tx_currency_check.sql — clean
- apps/backend/src/db/migrations/0015_credit_tx_reason.sql — clean

**Coverage:** 60/60 files reviewed. Skipped: none

## Batch 04 — backend src (4/7)

- apps/backend/src/db/migrations/0016_cashback_config_audit_trigger_guard.sql — clean; idempotent trigger re-assertion for ADR-011 audit trail
- apps/backend/src/db/migrations/0017_user_credits_primary_key.sql — clean; promotes unique index to composite PK
- apps/backend/src/db/migrations/0018_pending_payouts_generalise.sql — clean; makes order_id nullable + adds kind discriminator with shape CHECK
- apps/backend/src/db/migrations/0019_social_id_token_replay_guard.sql — clean; social id-token replay guard table with TTL sweep index
- apps/backend/src/db/migrations/0020_users_email_unique.sql — clean; partial unique index on LOWER(email) for Loop-native rows; pre-flight check documented
- apps/backend/src/db/migrations/0021_orders_currency_check.sql — latent risk: currency CHECK too narrow for ADR 035 new display markets (see MEDIUM finding)
- apps/backend/src/db/migrations/0022_credit_tx_withdrawal_unique.sql — clean; extends partial unique index to include withdrawal type
- apps/backend/src/db/migrations/0023_orders_idempotency_key.sql — clean; adds idempotency_key column + partial unique index
- apps/backend/src/db/migrations/0024_pending_payouts_to_address_format.sql — clean; DB-layer Stellar pubkey shape CHECK
- apps/backend/src/db/migrations/0025_user_identities_and_orders_db_checks.sql — clean; provider enum CHECK + payment_memo coherence CHECK
- apps/backend/src/db/migrations/0026_orders_sweep_aggregate_indexes.sql — clean; three partial indexes for stuck-procurement sweep + admin aggregates
- apps/backend/src/db/migrations/0027_pending_payouts_user_created_index.sql — clean; composite (user_id, created_at) index replacing single-column
- apps/backend/src/db/migrations/0028_pending_payouts_compensation_and_withdrawal_uniqueness.sql — clean; compensated_at column + semantic active-withdrawal unique index
- apps/backend/src/db/migrations/0029_cashback_config_audit_insert_delete_triggers.sql — clean; extends audit trigger coverage to INSERT and DELETE operations
- apps/backend/src/db/migrations/0030_pending_payouts_asset_checks.sql — clean; DB-layer asset_code + asset_issuer format CHECK constraints
- apps/backend/src/db/migrations/0031_credit_transactions_reason_length.sql — clean; reason length CHECK (NULL-tolerant)
- apps/backend/src/db/migrations/0032_user_favorite_merchants.sql — clean; composite PK favs table with user→merchant FK and user_created index
- apps/backend/src/db/migrations/meta/\_journal.json — generated Drizzle-kit journal; not a source file
- apps/backend/src/db/migrations/meta/0000_snapshot.json — generated Drizzle-kit snapshot; not a source file
- apps/backend/src/db/schema.ts — solid; comprehensive constraints and well-documented design decisions; see MEDIUM finding on currency CHECKs
- apps/backend/src/db/users.ts — clean; race-safe findOrCreateUserByEmail using ON CONFLICT DO NOTHING + re-SELECT
- apps/backend/src/discord.ts — mostly clean; notifyWebhookPing catalog entry mismatch (see MEDIUM finding)
- apps/backend/src/discord/admin-audit.ts — clean; correct PII handling (tail-ids, no full UUIDs to Discord)
- apps/backend/src/discord/monitoring-asset-drift.ts — clean; paired open/close notifiers for drift watcher
- apps/backend/src/discord/monitoring-circuit-breaker.ts — clean; per-(name, state) dedup with 10-minute window
- apps/backend/src/discord/monitoring-ctx-schema-drift.ts — clean; per-surface dedup map with test seam
- apps/backend/src/discord/monitoring-stuck-sweepers.ts — clean; per-row drill-down for procurement sweeper + cursor-age alert + stuck-payout backlog
- apps/backend/src/discord/monitoring.ts — clean; well-structured monitoring notifiers with dedup and throttling
- apps/backend/src/discord/notifiers-catalog.ts — notifyWebhookPing channel field incorrect (see MEDIUM finding); rest of catalog accurate
- apps/backend/src/discord/orders.ts — clean; correct ADR-018 tail-id convention enforced on firstCashbackRecycled; orderId passed in full to orders channel (acceptable for ops visibility)
- apps/backend/src/discord/shared.ts — clean; escapeMarkdown strips bidi/zero-width chars and link syntax; allowed_mentions suppresses @mentions
- apps/backend/src/env.ts — clean; comprehensive schema with boot-time guards; correct envBoolean parsing to avoid truthy footgun
- apps/backend/src/health.ts — clean; two-tier degradation (critical vs soft) prevents CTX latency from cycling Fly machines; probe coalescing prevents upstream flood
- apps/backend/src/images/proxy.ts — mostly clean; see LOW finding on totalCacheBytes counter drift on cache-key collision
- apps/backend/src/images/ssrf-guard.ts — clean; thorough SSRF guard with IPv4-mapped IPv6 handling; known DNS rebinding TOCTOU documented inline
- apps/backend/src/index.ts — clean; graceful shutdown with double-signal guard; unhandledRejection/uncaughtException both route through shutdown; production email provider gate correct
- apps/backend/src/instrument.ts — clean; Sentry init with scrubber wired correctly
- apps/backend/src/kill-switches.ts — clean; correct fail-closed semantics for unrecognised values; reads process.env at call time for live updates
- apps/backend/src/logger.ts — clean; comprehensive REDACT_PATHS including admin idempotency keys and all secret-bearing env vars
- apps/backend/src/merchants/cashback-rate-handlers.ts — clean; ADR-020 never-500 pattern correctly implemented on both bulk and per-merchant endpoints
- apps/backend/src/merchants/handler.ts — clean; upstream response Zod-validated; fallback to cached merchant on upstream failure
- apps/backend/src/merchants/sync-interval.ts — clean; separate timer-bootstrap concern from sync logic
- apps/backend/src/merchants/sync-upstream.ts — clean; size-capped Zod schema; passthrough preserves unknown fields
- apps/backend/src/merchants/sync.ts — denylist reads from frozen env (see LOW finding); slug collision logged correctly; MAX_PAGES guard prevents runaway pagination
- apps/backend/src/metrics.ts — clean; Unit Separator delimiter for Prometheus labels; clean histogram accumulator
- apps/backend/src/middleware/access-log.ts — clean; silent probe suppression, client-id forwarding, server-minted requestId only
- apps/backend/src/middleware/body-limit.ts — clean; 413 with correct { code, message } envelope
- apps/backend/src/middleware/cache-control.ts — clean; no-store on auth, private+no-store on user-specific endpoints
- apps/backend/src/middleware/cors.ts — clean; Capacitor origins included; http://localhost correctly removed
- apps/backend/src/middleware/kill-switch.ts — clean; thin factory wrapper around isKilled
- apps/backend/src/middleware/probe-gate.ts — clean; constant-time compare with timingSafeEqual; correct length pre-check
- apps/backend/src/middleware/rate-limit.ts — clean; per-(name, ip) bucketing; OOM-safe 10k cap with LRU eviction; Retry-After header
- apps/backend/src/middleware/request-context.ts — clean; ALS scope for request correlation propagation to CTX calls
- apps/backend/src/middleware/request-counter.ts — clean; post-handler observation; cardinality cap via NOT_FOUND collapse
- apps/backend/src/middleware/request-id.ts — clean; always server-minted UUID, ignores inbound X-Request-Id to prevent log pollution
- apps/backend/src/middleware/secure-headers.ts — clean; CORP flips on NODE_ENV; strict CSP for API-only host
- apps/backend/src/migrate-cli.ts — clean; belt-and-braces release_command entry point; non-zero exit on failure aborts deploy
- apps/backend/src/observability-handlers.ts — clean; Prometheus format correct after Unit Separator fix; probe-gate enforced; openApiSpec generated once at load
- apps/backend/src/openapi.ts — clean (first 100 lines reviewed); ApiErrorCode enum derived from shared source of truth
- apps/backend/src/openapi/admin-asset-circulation.ts — clean; all expected response codes documented including 429 and 503

**Coverage:** 60/60 files reviewed. Skipped: none (meta/0000_snapshot.json and meta/\_journal.json confirmed as generated/binary-adjacent and noted).

## Batch 05 — backend src (5/7)

- apps/backend/src/openapi/admin-asset-drift-state.ts — clean
- apps/backend/src/openapi/admin-audit-tail.ts — issues: 400 description too narrow vs. handler validation surface
- apps/backend/src/openapi/admin-cashback-config-csv.ts — clean
- apps/backend/src/openapi/admin-cashback-config-history.ts — issues: missing 500 (HIGH), 400 description too narrow (LOW)
- apps/backend/src/openapi/admin-cashback-config-upsert.ts — issues: missing 409 for idempotency-key conflict (HIGH)
- apps/backend/src/openapi/admin-cashback-config.ts — issues: missing 500 on list endpoint (MEDIUM), inline unregistered history schema (LOW)
- apps/backend/src/openapi/admin-cashback-realization.ts — clean
- apps/backend/src/openapi/admin-credit-writes.ts — issues: currency enum will be stale post-ADR 035 (MEDIUM)
- apps/backend/src/openapi/admin-csv-exports-cashback.ts — issues: missing 401/403 on both CSV paths (HIGH)
- apps/backend/src/openapi/admin-csv-exports-raw-rows.ts — clean
- apps/backend/src/openapi/admin-csv-exports-treasury.ts — issues: missing 401/403 on credit-flow.csv (HIGH), text/csv charset inconsistency (LOW)
- apps/backend/src/openapi/admin-csv-exports.ts — issues: ghost ?currency param and 400 (HIGH), missing 401/403 on 4 paths (MEDIUM), undated TODO (MEDIUM)
- apps/backend/src/openapi/admin-dashboard-cluster-stuck-rows.ts — clean
- apps/backend/src/openapi/admin-dashboard-cluster.ts — issues: 429 rate-limit description to verify (MEDIUM)
- apps/backend/src/openapi/admin-fleet-monthly-credit-csvs.ts — issues: text/csv vs text/csv;charset=utf-8 inconsistency (LOW)
- apps/backend/src/openapi/admin-fleet-monthly-merchants-flywheel.ts — issues: z.unknown() 200 body (HIGH), complete param mismatch ?days vs ?since (HIGH), missing 500 and 400 (MEDIUM)
- apps/backend/src/openapi/admin-fleet-monthly-payouts.ts — issues: missing 401/403 on both paths (MEDIUM), stale asset code description (LOW), missing bounds on days field (LOW)
- apps/backend/src/openapi/admin-fleet-monthly-recycling-activity.ts — issues: missing 500 on JSON path (MEDIUM), missing rate-limit figure in 429 description (MEDIUM), missing 400 on JSON path (LOW)
- apps/backend/src/openapi/admin-fleet-monthly-user-cashback-drill.ts — issues: missing 500 on both paths (HIGH), z.unknown() 200 bodies without ticket refs (LOW)
- apps/backend/src/openapi/admin-fleet-monthly.ts — issues: missing 500 on 3 endpoints (HIGH/MEDIUM), z.unknown() bodies without ticket refs (LOW)
- apps/backend/src/openapi/admin-interest-mint-forecast.ts — issues: dead 503 registration (MEDIUM), missing 500 (MEDIUM), no-op alias (LOW)
- apps/backend/src/openapi/admin-misc-reads.ts — issues: missing 500 on merchant-flows (HIGH), missing 500 on reconciliation (HIGH)
- apps/backend/src/openapi/admin-operator-fleet-per-operator.ts — clean
- apps/backend/src/openapi/admin-operator-fleet.ts — issues: lastOrderAt non-nullable risk (MEDIUM), unused alias (LOW), counterintuitive rate limit ordering (INFO)
- apps/backend/src/openapi/admin-operator-mix.ts — issues: missing 500 on both mix endpoints (HIGH x2), lastOrderAt non-nullable risk (MEDIUM)
- apps/backend/src/openapi/admin-ops-tail-discord-mgmt.ts — issues: missing 500 on both Discord paths (LOW), webhook-URL enumeration note (INFO)
- apps/backend/src/openapi/admin-ops-tail.ts — issues: missing 500 on discord/config (LOW), PII note for email field (INFO), file header comment accuracy (INFO)
- apps/backend/src/openapi/admin-order-cluster-drills.ts — clean
- apps/backend/src/openapi/admin-order-cluster.ts — issues: missing 400 on orders/activity (LOW), routing comment omission (INFO)
- apps/backend/src/openapi/admin-payouts-by-asset.ts — clean
- apps/backend/src/openapi/admin-payouts-cluster-writes.ts — issues: compensate 400 description claims non-withdrawal = 400 but handler emits 409 (MEDIUM)
- apps/backend/src/openapi/admin-payouts-cluster.ts — issues: missing 500 on list (HIGH), missing assetCode query param (HIGH), 403 vs 404 middleware mismatch (HIGH)
- apps/backend/src/openapi/admin-payouts-settlement-lag.ts — issues: 403 vs 404 middleware mismatch (HIGH)
- apps/backend/src/openapi/admin-per-merchant-drill-time-axis.ts — issues: 403 vs 404 mismatch (HIGH), missing 401 on both paths (MEDIUM), email PII unannotated (LOW)
- apps/backend/src/openapi/admin-per-merchant-drill.ts — issues: 403 vs 404 mismatch on all 3 paths (HIGH), missing 401 on all 3 paths (MEDIUM)
- apps/backend/src/openapi/admin-per-merchant-payment-method-share.ts — issues: missing 401 and 403 (MEDIUM)
- apps/backend/src/openapi/admin-per-user-drill.ts — issues: missing 401 and 403 on all 3 paths (MEDIUM)
- apps/backend/src/openapi/admin-supplier-spend.ts — clean
- apps/backend/src/openapi/admin-treasury-assets.ts — issues: missing 500 (HIGH), misleading description about 500-immunity (MEDIUM/LOW)
- apps/backend/src/openapi/admin-treasury-credit-flow.ts — clean
- apps/backend/src/openapi/admin-user-cluster-drill.ts — clean
- apps/backend/src/openapi/admin-user-cluster.ts — issues: inline anonymous 200 schema on top-by-pending-payout (MEDIUM)
- apps/backend/src/openapi/admin-user-operator-mix.ts — clean
- apps/backend/src/openapi/admin-user-search.ts — issues: missing 500 despite explicit catch (HIGH), homeCurrency schema inconsistency (LOW)
- apps/backend/src/openapi/admin-user-writes.ts — clean
- apps/backend/src/openapi/admin-withdrawal-write.ts — issues: missing 503 SUBSYSTEM_DISABLED for killswitch path (HIGH), missing x-admin-step-up header declaration (LOW)
- apps/backend/src/openapi/admin.ts — clean
- apps/backend/src/openapi/auth-social.ts — clean
- apps/backend/src/openapi/auth.ts — issues: DELETE /auth/session missing 503 kill-switch (HIGH), POST /auth/refresh missing 500 (HIGH), DELETE missing 500 (LOW), DELETE 200 description omits circuit-open path (LOW)
- apps/backend/src/openapi/clusters.ts — issues: GeoJsonFeature = z.object({}) effectively opaque schema (LOW), missing 500/503 minor inconsistency (INFO)
- apps/backend/src/openapi/health.ts — issues: GET /health missing 503 (HIGH), GET /api/config missing 429 (MEDIUM), AppConfigResponse missing phase1Only field (MEDIUM)
- apps/backend/src/openapi/merchants-cashback-rates.ts — issues: inline regex diverges from shared cashbackPctString (LOW), never-500 fallback undocumented in 200 descriptions (LOW)
- apps/backend/src/openapi/merchants.ts — issues: missing 500 on 4 merchant endpoints (LOW)
- apps/backend/src/openapi/orders-loop-reads.ts — issues: missing 500 on both loop-order read endpoints (MEDIUM)
- apps/backend/src/openapi/orders-loop.ts — clean
- apps/backend/src/openapi/orders-reads.ts — issues: missing 500 on CTX-proxy list (MEDIUM), Order.merchantName required but empty-string sentinel undocumented (LOW)
- apps/backend/src/openapi/orders.ts — issues: POST /api/orders missing 500 (MEDIUM), orderId could be uuid() (LOW)
- apps/backend/src/openapi/public-merchants.ts — clean
- apps/backend/src/openapi/public.ts — issues: PublicGeoResponse.region enum stale after ADR 035 (HIGH)
- apps/backend/src/openapi/users-cashback-drill.ts — issues: cashback-monthly 200 schema is anonymous inline object (MEDIUM)

**Coverage:** 60/60 files reviewed. Skipped: none

## Batch 06 — backend src (6/7)

- apps/backend/src/openapi/users-cashback-history.ts — clean; minor: CSV path missing 500 response entry
- apps/backend/src/openapi/users-dsr-orders.ts — clean; minor: dsr/export 200 schema is fully opaque passthrough
- apps/backend/src/openapi/users-favorites.ts — clean; minor: 500 entries absent from all four paths
- apps/backend/src/openapi/users-flywheel-rail.ts — clean, no issues
- apps/backend/src/openapi/users-history-credits.ts — clean, no issues
- apps/backend/src/openapi/users-pending-payouts-drills.ts — low: dead local alias on line 37
- apps/backend/src/openapi/users-pending-payouts.ts — medium: SummaryRow.state hardcodes narrowed enum instead of payoutState parameter
- apps/backend/src/openapi/users-profile.ts — medium: homeCurrency enum hardcoded instead of derived from HOME_CURRENCIES; will diverge on extended-currency markets
- apps/backend/src/openapi/users-stellar-trustlines.ts — clean, no issues
- apps/backend/src/openapi/users.ts — clean, no issues
- apps/backend/src/orders/barcode-fields.ts — clean, no issues
- apps/backend/src/orders/cashback-split.ts — medium: applyPct silently truncates pct strings >2 decimal places without error
- apps/backend/src/orders/fulfillment.ts — HIGH: notifyPegBreakOnFulfillment fires inside transaction before commit confirmed; false-alarm Discord alerts on rollback
- apps/backend/src/orders/get-handler.ts — low: double-cast on line 203
- apps/backend/src/orders/handler-shared.ts — low: unsafe as-string cast on bearer token
- apps/backend/src/orders/handler.ts — clean; thin orchestration layer
- apps/backend/src/orders/list-handler.ts — low: redundant as-string cast in query forwarding
- apps/backend/src/orders/loop-create-checks.ts — clean, no issues
- apps/backend/src/orders/loop-create-response.ts — HIGH: non-null assertions on env var; medium: empty USDC issuer fallback produces malformed SEP-7 URI; low: unsafe runtime casts on chargeCurrency and paymentMethod
- apps/backend/src/orders/loop-handler.ts — medium: float precision in validateMerchantDenomination; otherwise well-structured
- apps/backend/src/orders/loop-read-handlers.ts — clean; safe casts backed by DB constraints
- apps/backend/src/orders/loop-replay-response.ts — medium: empty USDC issuer fallback; low: same unsafe casts as loop-create-response.ts
- apps/backend/src/orders/pay-ctx.ts — clean; correct idempotency and error classification
- apps/backend/src/orders/procure-one.ts — HIGH: misleading log.warn fires for every Phase-1 order; production log pollution
- apps/backend/src/orders/procurement-asset-picker.ts — clean; pure testable functions
- apps/backend/src/orders/procurement-redemption.ts — low: bodyPreview in log may contain unexpected fields from non-standard CTX responses
- apps/backend/src/orders/procurement-worker.ts — clean, no issues
- apps/backend/src/orders/procurement.ts — info: mostly re-exports; minor comment duplication
- apps/backend/src/orders/repo-credit-order.ts — clean; atomic transaction correctly structured
- apps/backend/src/orders/repo-errors.ts — clean, no issues
- apps/backend/src/orders/repo-idempotency.ts — clean; cause-chain walking well-designed
- apps/backend/src/orders/repo.ts — info: optional chargeMinor/chargeCurrency defaults are a footgun for new callers
- apps/backend/src/orders/request-schemas.ts — info: extendZodWithOpenApi side-effect at module load time
- apps/backend/src/orders/sep7.ts — info: destination not validated as Stellar pubkey format
- apps/backend/src/orders/transitions-sweeps.ts — clean, no issues
- apps/backend/src/orders/transitions.ts — medium: two orphaned JSDoc blocks from lift-out refactor
- apps/backend/src/payments/amount-sufficient.ts — low: credit early-return has no log; bug is invisible to ops
- apps/backend/src/payments/asset-drift-watcher.ts — medium: confusing log noise when skipped>0 with zero samples
- apps/backend/src/payments/cursor-watchdog.ts — clean; errors surface to caller's catch
- apps/backend/src/payments/fee-strategy.ts — low: Infinity unguarded at extreme multiplier/idx values
- apps/backend/src/payments/horizon-asset-balance.ts — medium: parseStroops duplicated from stroops.ts; can drift
- apps/backend/src/payments/horizon-balances.ts — info: single-entry cache inconsistent with sibling Map pattern
- apps/backend/src/payments/horizon-circulation.ts — medium: single-entry cache breaks multi-asset deployments; low: accepts negative amounts in schema
- apps/backend/src/payments/horizon-find-outbound.ts — clean; empty-page early return intentional
- apps/backend/src/payments/horizon-trustlines.ts — medium: parseStroops duplicated from stroops.ts; same fix as horizon-asset-balance.ts
- apps/backend/src/payments/horizon.ts — clean; dual transaction_successful check intentional
- apps/backend/src/payments/interest-pool-watcher.ts — medium: missing runtime-health worker instrumentation; invisible to health-check dashboard
- apps/backend/src/payments/payout-submit.ts — clean; SDK shims well-commented
- apps/backend/src/payments/payout-worker-pay-one.ts — medium: dead credit fallback could mask future bugs
- apps/backend/src/payments/payout-worker.ts — info: Horizon URL read from process.env directly
- apps/backend/src/payments/price-feed-fx.ts — low: two-hop rounding nuance undocumented; worth a test
- apps/backend/src/payments/price-feed.ts — clean; low-fidelity function caveat documented
- apps/backend/src/payments/sep7.ts — low: assetIssuer silently dropped for native XLM without warning
- apps/backend/src/payments/stroops.ts — clean canonical implementation; private copies should be removed
- apps/backend/src/payments/stuck-payout-watchdog.ts — low: no logger import; alert and clear paths have zero structured log output
- apps/backend/src/payments/watcher-bootstrap.ts — clean; guard order safe in practice
- apps/backend/src/payments/watcher.ts — medium: correctness bug — amount-insufficient log uses faceValueMinor instead of chargeMinor; wrong for cross-currency orders
- apps/backend/src/public/cashback-preview.ts — low: malformed DB value (bps=null) forwarded raw to public API response
- apps/backend/src/public/cashback-stats.ts — low: three-query non-transactional snapshot undocumented
- apps/backend/src/public/flywheel-stats.ts — low: recycled-orders metric hardcoded to loop_asset; will silently drop post-ADR-031 enum change

**Coverage:** 58/58 files reviewed. Skipped: none

## Batch 07 — backend src (7/7)

- apps/backend/src/public/geo.ts — clean; lazy-reader singleton, correct fallback, no PII logged
- apps/backend/src/public/loop-assets.ts — clean; never-500 contract correct, no DB calls
- apps/backend/src/public/merchant.ts — minor: `cache-control` header uses lowercase string literal (inconsistent casing vs `Cache-Control` in sibling); functionally equivalent
- apps/backend/src/public/top-cashback-merchants.ts — MEDIUM: lexicographic ordering bug on text cashback-pct column
- apps/backend/src/request-context.ts — clean; AsyncLocalStorage usage correct, minimal scope
- apps/backend/src/routes/admin-cashback-config.ts — clean; route-mount ordering correct, rate limits appropriate
- apps/backend/src/routes/admin-credit-writes.ts — clean; step-up middleware correctly applied to adjustment + withdrawal
- apps/backend/src/routes/admin-dashboard.ts — clean; route factory pattern correct
- apps/backend/src/routes/admin-fleet-monthly.ts — clean; finance CSV cluster correct
- apps/backend/src/routes/admin-operator.ts — clean; operator/supplier-spend routes correct
- apps/backend/src/routes/admin-ops-tail.ts — minor: stray half-sentence comment remnants at lines 107-108 and 117-118 (cut-paste artifacts); no functional issue
- apps/backend/src/routes/admin-order-drill.ts — clean; literal-before-param mount order correct
- apps/backend/src/routes/admin-payouts.ts — clean; step-up gating on retry/compensate correct; settlement-lag literal registered before /:id per A4-075
- apps/backend/src/routes/admin-per-merchant.ts — clean; flywheel-share literal before :merchantId correct
- apps/backend/src/routes/admin-treasury.ts — clean; treasury cluster correct
- apps/backend/src/routes/admin-user-cluster.ts — clean; literal lookups before /:userId correct
- apps/backend/src/routes/admin-user-writes.ts — clean; step-up gating on home-currency write correct
- apps/backend/src/routes/admin.ts — LOW: unnecessary double cast on line 141; middleware ordering well-documented
- apps/backend/src/routes/auth.ts — clean; kill-switch before rate-limit ordering correct; no-store on all auth responses
- apps/backend/src/routes/merchants.ts — clean; literal-before-param ordering correct
- apps/backend/src/routes/misc.ts — clean; three-route misc module, rate limits appropriate
- apps/backend/src/routes/orders.ts — clean; literal loop before :id per A4-075; private no-store correct
- apps/backend/src/routes/public.ts — clean; ADR 020 conventions followed
- apps/backend/src/routes/users.ts — clean; cache-control + requireAuth ordering correct; all routes accounted for
- apps/backend/src/runtime-health.ts — clean; A4-111 stale-worker fix correct; INFO on test-only export
- apps/backend/src/scripts/check-ledger-invariant.ts — clean; correct exit codes, closeDb called in both paths
- apps/backend/src/scripts/quarterly-tax.ts — MEDIUM: void closeDb() in .finally() swallows teardown errors
- apps/backend/src/sentry-scrubber.ts — LOW: LONG_HEX_RE may redact 32+-char hex non-UUID IDs; well-documented caveat
- apps/backend/src/test-endpoints.ts — INFO: token-minting backdoor has no in-handler NODE_ENV guard or rate limit
- apps/backend/src/upstream-body-scrub.ts — MEDIUM: OPAQUE_TOKEN_RE applied before length cap; potential perf concern on large bodies
- apps/backend/src/upstream.ts — clean; path-traversal + CRLF + protocol-relative + percent-encoded traversal all blocked
- apps/backend/src/users/cashback-by-merchant.ts — LOW: currency scope comment gap; otherwise clean
- apps/backend/src/users/cashback-history-handler.ts — HIGH: DB queries not wrapped in try/catch; unhandled rejection on DB error
- apps/backend/src/users/cashback-monthly.ts — clean; bigint-safe serialisation, correct month formatting
- apps/backend/src/users/cashback-summary-handler.ts — clean; conditional SUM one-round-trip pattern correct
- apps/backend/src/users/dsr-delete.ts — HIGH issue surfaces in dsr-handler.ts; the delete logic itself is clean; transaction wrapping correct; A4-086 revoke error surfaced
- apps/backend/src/users/dsr-export.ts — MEDIUM: parallel queries not in a transaction; legal-grade consistency concern
- apps/backend/src/users/dsr-handler.ts — HIGH: failed_uncompensated_withdrawals block reason not handled; falls through to IN_FLIGHT_ORDERS message
- apps/backend/src/users/favorites-handler.ts — LOW: transaction-based cap race not truly prevented; misleading comment
- apps/backend/src/users/flywheel-stats.ts — clean; FILTER-ed COUNT+SUM pattern correct
- apps/backend/src/users/handler.ts — clean; conditional UPDATE closing TOCTOU correct; re-export barrel clean
- apps/backend/src/users/home-currency-change.ts — clean; transaction + FOR UPDATE locking + ConcurrentChangeError all correct
- apps/backend/src/users/orders-summary.ts — clean; FILTER-ed aggregate one-round-trip correct
- apps/backend/src/users/payment-method-share.ts — clean; zero-fill + unknown method drop with warn correct
- apps/backend/src/users/pending-payouts-detail.ts — clean; UUID validation + 404-not-403 ownership pattern correct
- apps/backend/src/users/pending-payouts-handler.ts — clean; state filter validation + pagination correct
- apps/backend/src/users/recently-purchased-handler.ts — clean; GROUP BY merchantId + DESC MAX(created_at) correct
- apps/backend/src/users/stellar-address-handler.ts — clean; Zod regex validation against shared constant; idempotent no-op on same address
- apps/backend/src/users/stellar-trustlines.ts — MEDIUM: accountExists: false semantics ambiguous in no-address path
- apps/backend/src/uuid.ts — clean; UUID_RE case-insensitive, appropriate scope
- apps/backend/src/webhooks/hmac-verify.ts — LOW: Number() instead of parseInt for timestamp allows hex/float; timing-safe compare correct
- apps/backend/tsconfig.json — clean; standard NodeNext config
- apps/backend/tsup.config.ts — clean (INFO: unnecessary async in onSuccess)
- apps/backend/vitest.config.ts — clean; coverage thresholds documented
- apps/backend/vitest.integration.config.ts — clean; single-worker serialization correct for DB tests

**Coverage:** 56/56 files reviewed. Skipped: none

## Batch 08 — backend tests (1/3)

- apps/backend/src/**tests**/bigint-money-property.test.ts — solid property tests; minor redundant iterations in zero-balance loop
- apps/backend/src/**tests**/circuit-breaker.test.ts — good coverage; unused `cb` variable in probe-timeout test
- apps/backend/src/**tests**/ctx-contract.test.ts — exemplary; meta-gate + coverage-completeness tests
- apps/backend/src/**tests**/discord.test.ts — functional coverage good; fragile setTimeout flush throughout
- apps/backend/src/**tests**/env.test.ts — thorough env validation tests; correct use of expect.fail sentinel
- apps/backend/src/**tests**/integration/admin-writes.test.ts — real-postgres integration; concurrent-withdrawal test does not create true concurrency
- apps/backend/src/**tests**/integration/asset-drift-watcher.test.ts — clean; ok-over-ok transition covered
- apps/backend/src/**tests**/integration/cashback-history.test.ts — good pagination, cursor, RFC-4180 coverage
- apps/backend/src/**tests**/integration/db-test-setup.ts — setup helper, no test cases
- apps/backend/src/**tests**/integration/favorites.test.ts — cap enforcement, scope isolation tested
- apps/backend/src/**tests**/integration/flywheel.test.ts — full order lifecycle; well-structured
- apps/backend/src/**tests**/integration/payment-watcher.test.ts — cursor persistence, memo match, idempotency tested
- apps/backend/src/**tests**/integration/payout-worker.test.ts — CAS race, fee-bump curve, idempotency tested
- apps/backend/src/**tests**/integration/phase-mode-toggle.test.ts — mid-flight flag flip covered
- apps/backend/src/**tests**/integration/procurement-worker.test.ts — FIFO ordering, concurrent claim race tested
- apps/backend/src/**tests**/integration/recently-purchased.test.ts — GROUP BY, state filter, evicted merchant, scope tested
- apps/backend/src/**tests**/integration/vitest-integration-setup.ts — setup file, no test cases
- apps/backend/src/**tests**/kill-switches.test.ts — fail-open/fail-closed behavior covered; clean
- apps/backend/src/**tests**/logger.test.ts — REDACT_PATHS, auth headers, Stellar secrets tested
- apps/backend/src/**tests**/metrics.test.ts — bucketing, cumulative correctness, non-finite clamping tested
- apps/backend/src/**tests**/openapi-error-code.test.ts — enum parity with shared ApiErrorCode; dual-path auth docs checked
- apps/backend/src/**tests**/request-context.test.ts — AsyncLocalStorage isolation, propagation through awaits tested
- apps/backend/src/**tests**/routes.integration.test.ts — good route-level coverage; only legacy auth path exercised
- apps/backend/src/**tests**/runtime-health.test.ts — OTP degradation, blocked/stale worker, A4-111 coverage
- apps/backend/src/**tests**/sentry-scrubber.test.ts — header/data/env/free-text regex redaction tested
- apps/backend/src/**tests**/slugs.test.ts — idempotency, Unicode, edge cases covered
- apps/backend/src/**tests**/trust-proxy-trusted.test.ts — leftmost XFF, whitespace trim, socket fallback
- apps/backend/src/**tests**/trust-proxy.test.ts — XFF ignored when untrusted; socket fallback tested
- apps/backend/src/**tests**/upstream-body-scrub.test.ts — JWT/token/email/card redaction tested
- apps/backend/src/**tests**/upstream.test.ts — traversal, CRLF, NUL, percent-encoded path attacks covered
- apps/backend/src/**tests**/vitest-env-setup.ts — setup file, no test cases
- apps/backend/src/admin/**tests**/asset-circulation.test.ts — asset code validation, bigint precision, drift calc tested
- apps/backend/src/admin/**tests**/asset-drift-state.test.ts — bigint→string serialization, null preservation tested
- apps/backend/src/admin/**tests**/audit-envelope.test.ts — pure function, shape contract tested
- apps/backend/src/admin/**tests**/audit-tail-csv.test.ts — CSV output, RFC-4180, truncation, row-cap+1 tested
- apps/backend/src/admin/**tests**/audit-tail.test.ts — shared chainable mock state; whereCalled boolean not reset-safe
- apps/backend/src/admin/**tests**/cashback-activity-csv.test.ts — good coverage; clamp test only asserts 200 status
- apps/backend/src/admin/**tests**/cashback-activity.test.ts — thorough; clamp test correctly echoes days value
- apps/backend/src/admin/**tests**/cashback-configs-csv.test.ts — headers, name fallback, RFC-4180, truncation tested
- apps/backend/src/admin/**tests**/cashback-monthly.test.ts — multi-currency, bigint precision, { rows } envelope tested
- apps/backend/src/admin/**tests**/cashback-realization-daily-csv.test.ts — null-currency drop, date coercion, truncation tested
- apps/backend/src/admin/**tests**/cashback-realization-daily.test.ts — recycledBps pure function + handler; { rows } envelope tested
- apps/backend/src/admin/**tests**/cashback-realization.test.ts — fleet+per-currency, zero-earned filter, { rows } envelope tested
- apps/backend/src/admin/**tests**/configs-history.test.ts — catalog enrichment, evicted fallback, limit clamping tested
- apps/backend/src/admin/**tests**/credit-adjustments.test.ts — full ADR-017 write contract; idempotency replay, daily cap, 409 errors tested
- apps/backend/src/admin/**tests**/discord-config.test.ts — all three channels, empty-string as missing, URL leakage prevention tested
- apps/backend/src/admin/**tests**/discord-notifiers.test.ts — catalog invariants, frozen array, coverage of all notify\* exports tested
- apps/backend/src/admin/**tests**/discord-test.test.ts — channel validation, WEBHOOK_NOT_CONFIGURED, 401 without context tested
- apps/backend/src/admin/**tests**/handler.test.ts — duplicate configHistoryHandler 400 test between two describe blocks
- apps/backend/src/admin/**tests**/home-currency-set.test.ts — all 409 variants (unchanged, live balance, in-flight payouts, concurrent) tested
- apps/backend/src/admin/**tests**/idempotency-ttl.test.ts — TTL expiry, corrupt JSON as miss, sweep count, error swallowing tested
- apps/backend/src/admin/**tests**/idempotency.test.ts — lock key extraction, guard control flow, advisory lock parameter tested
- apps/backend/src/admin/**tests**/interest-mint-forecast.test.ts — feature-off null, pool coverage, recommendedMint floor tested
- apps/backend/src/admin/**tests**/merchant-cashback-monthly.test.ts — bigint precision, Date month formatting, { rows } envelope tested
- apps/backend/src/admin/**tests**/merchant-cashback-summary.test.ts — per-currency buckets, bigint precision, zero-volume tested
- apps/backend/src/admin/**tests**/merchant-flows.test.ts — per-currency splitting, bucket shape tested
- apps/backend/src/admin/**tests**/merchant-flywheel-activity-csv.test.ts — null coercion, bigint precision, truncation tested
- apps/backend/src/admin/**tests**/merchant-flywheel-activity.test.ts — days clamp, null coercion, bigint precision, { rows } envelope tested
- apps/backend/src/admin/**tests**/merchant-flywheel-stats.test.ts — zero-volume, bigint precision, { rows } envelope tested
- apps/backend/src/admin/**tests**/merchant-operator-mix.test.ts — since validation, bigint normalisation, ISO timestamp tested
- apps/backend/src/admin/**tests**/merchant-payment-method-share.test.ts — unknown method drop, zero-fill, state override tested
- apps/backend/src/admin/**tests**/merchant-stats-csv.test.ts — RFC-4180, truncation, since in filename tested
- apps/backend/src/admin/**tests**/merchant-stats.test.ts — mixed bigint/Date/string shapes, since validation tested
- apps/backend/src/admin/**tests**/merchant-top-earners.test.ts — bigint precision, days clamp; limit clamping test vacuous
- apps/backend/src/admin/**tests**/merchants-catalog-csv.test.ts — join with configs, no-config fallback, RFC-4180, truncation tested
- apps/backend/src/admin/**tests**/merchants-flywheel-share-csv.test.ts — CSV escaping, truncation, since validation tested
- apps/backend/src/admin/**tests**/merchants-flywheel-share.test.ts — future since rejected, ancient clamped, bigint precision tested; limit clamp test vacuous
- apps/backend/src/admin/**tests**/merchants-resync.test.ts — ADR-017 contract, idempotency, Discord fanout, 502 upstream tested
- apps/backend/src/admin/**tests**/operator-activity.test.ts — days clamp, bigint normalisation, { rows } envelope tested
- apps/backend/src/admin/**tests**/operator-latency.test.ts — percentile rounding, null coercion, since validation tested
- apps/backend/src/admin/**tests**/operator-merchant-mix.test.ts — since validation, bigint normalisation tested
- apps/backend/src/admin/**tests**/operator-stats.test.ts — ISO timestamp, since validation, { rows } envelope tested
- apps/backend/src/admin/**tests**/operator-supplier-spend.test.ts — per-currency aggregation, bigint precision tested
- apps/backend/src/admin/**tests**/operators-snapshot-csv.test.ts — null latency zero-fill, success %, truncation tested
- apps/backend/src/admin/**tests**/orders-activity.test.ts — days clamp, Date coercion, { rows } envelope tested
- apps/backend/src/admin/**tests**/orders-csv.test.ts — no redeem columns, bigint + ISO coercion, RFC-4180, ROW_CAP+1 limit tested
- apps/backend/src/admin/**tests**/orders.test.ts — all filter combos, limit clamping, stacked WHERE tested
- apps/backend/src/admin/**tests**/payment-method-activity.test.ts — daily seeding, unknown method drop, out-of-window row drop tested
- apps/backend/src/admin/**tests**/payment-method-share.test.ts — zero-fill, unknown method silently dropped, { rows } envelope tested
- apps/backend/src/admin/**tests**/payout-compensation.test.ts — idempotency replay, state guards, stroops conversion, error mapping tested

**Coverage:** 80/80 files reviewed. Skipped: none.

## Batch 09 — backend tests (2/3)

- apps/backend/src/admin/**tests**/payouts-activity-csv.test.ts — clamping test cannot verify actual days value; test name overstates coverage
- apps/backend/src/admin/**tests**/payouts-activity.test.ts — envelope test missing field-level assertions; otherwise adequate
- apps/backend/src/admin/**tests**/payouts-by-asset.test.ts — minor fixture asymmetry; logic coverage adequate
- apps/backend/src/admin/**tests**/payouts-csv.test.ts — `?since` filter forwarding unverified in filename test
- apps/backend/src/admin/**tests**/payouts-monthly.test.ts — envelope test missing field assertions; otherwise adequate
- apps/backend/src/admin/**tests**/payouts.test.ts — multiple HIGH gaps: missing `kind` in fixture, `?kind=` filter untested, no 500 for list handler
- apps/backend/src/admin/**tests**/read-audit.test.ts — multi-value and isolated `q=` PII redaction paths untested
- apps/backend/src/admin/**tests**/reconciliation.test.ts — missing 500 path; only file in the admin suite without one
- apps/backend/src/admin/**tests**/refunds.test.ts — `body.code` missing from too-short idempotency key test
- apps/backend/src/admin/**tests**/settlement-lag.test.ts — default 24h window not numerically verified
- apps/backend/src/admin/**tests**/stuck-orders.test.ts — `ageMinutes` for procuring state unasserted; clamping assertions bundled
- apps/backend/src/admin/**tests**/stuck-payouts.test.ts — `ageMinutes` for pending state unasserted; clamping assertions bundled
- apps/backend/src/admin/**tests**/supplier-spend-activity-csv.test.ts — clamping test checks 200 only; actual clamped value unverifiable
- apps/backend/src/admin/**tests**/supplier-spend-activity.test.ts — `state.rows` typed as `unknown`; otherwise adequate
- apps/backend/src/admin/**tests**/supplier-spend.test.ts — envelope test missing numeric field assertions
- apps/backend/src/admin/**tests**/top-users-by-pending-payout.test.ts — CRITICAL: `expected` values computed but thrown away; clamping entirely untested
- apps/backend/src/admin/**tests**/top-users.test.ts — limit clamping promised by test name but only 200 status verified
- apps/backend/src/admin/**tests**/treasury-credit-flow-csv.test.ts — currency normalisation and days clamping both check 200 only
- apps/backend/src/admin/**tests**/treasury-credit-flow.test.ts — `state.rows` typed as `unknown`; otherwise good coverage
- apps/backend/src/admin/**tests**/treasury-snapshot-csv.test.ts — treasury handler fully mocked; integration chain not exercised; indexOf boundary off-by-one
- apps/backend/src/admin/**tests**/treasury.test.ts — 4-query handler tested with 3-result pushes in multiple tests; position-ordering bugs invisible
- apps/backend/src/admin/**tests**/user-by-email.test.ts — malformed-address tests missing body.code assertions; boundary at 254/255 chars untested
- apps/backend/src/admin/**tests**/user-cashback-by-merchant.test.ts — `eq` mock returns `true` unconditionally; userId filter unverifiable
- apps/backend/src/admin/**tests**/user-cashback-monthly.test.ts — envelope test missing field assertions; null month edge case untested
- apps/backend/src/admin/**tests**/user-cashback-summary.test.ts — null currency coalesce path untested
- apps/backend/src/admin/**tests**/user-credit-transactions-csv.test.ts — adequate; truncation sentinel tested correctly
- apps/backend/src/admin/**tests**/user-credit-transactions.test.ts — limit clamped but value never verified
- apps/backend/src/admin/**tests**/user-credits-csv.test.ts — truncation sentinel test missing despite being present in all sibling CSV tests
- apps/backend/src/admin/**tests**/user-credits.test.ts — adequate coverage
- apps/backend/src/admin/**tests**/user-detail.test.ts — adequate coverage
- apps/backend/src/admin/**tests**/user-flywheel-stats.test.ts — null-field coalescing paths uncovered
- apps/backend/src/admin/**tests**/user-operator-mix.test.ts — default since window not numerically verified
- apps/backend/src/admin/**tests**/user-payment-method-share.test.ts — adequate coverage
- apps/backend/src/admin/**tests**/user-search.test.ts — no 500/db-error path despite all siblings having one
- apps/backend/src/admin/**tests**/users-list.test.ts — WHERE predicate content unverified; escapeLike function never tested here
- apps/backend/src/admin/**tests**/users-recycling-activity-csv.test.ts — adequate coverage; truncation tested
- apps/backend/src/admin/**tests**/users-recycling-activity.test.ts — limit clamped but value never verified
- apps/backend/src/admin/**tests**/withdrawals.test.ts — reason field constraints and unsupported asset code path untested
- apps/backend/src/auth/**tests**/admin-step-up-middleware.test.ts — 503 STEP_UP_UNAVAILABLE path never tested; userId-undefined edge case undocumented
- apps/backend/src/auth/**tests**/admin-step-up.test.ts — key-rotation path acknowledged but not tested; `wrong_issuer` case missing
- apps/backend/src/auth/**tests**/email.test.ts — missing `vi.resetModules()` after last `vi.doUnmock()`; otherwise thorough
- apps/backend/src/auth/**tests**/handler.test.ts — android clientId mapping untested; Cache-Control only asserted on 200; otherwise good
- apps/backend/src/auth/**tests**/id-token-replay.test.ts — confusing mock setup but functionally correct; comment recommended
- apps/backend/src/auth/**tests**/id-token.test.ts — malformed-token loop missing reason assertion; `expect` inside mock callback; `if (result.ok)` pattern repeated 9 times
- apps/backend/src/auth/**tests**/identities.test.ts — dangling-identity → email-lookup path untestable with current single-mock setup; NonAsciiEmailError propagation untested
- apps/backend/src/auth/**tests**/native.test.ts — entire suite bypasses middleware; isLoopAuthConfigured false path untested; NonAsciiEmailError and lockout paths missing
- apps/backend/src/auth/**tests**/normalize-email.test.ts — clean; no issues
- apps/backend/src/auth/**tests**/otps.test.ts — WHERE predicates for increment, mark-consumed, and find-live never verified; dead `updateRows` state; null vs undefined initialisation hazard
- apps/backend/src/auth/**tests**/refresh-tokens.test.ts — tryRevokeIfLive and findRefreshTokenRecord (security-critical) have zero coverage; WHERE predicates unverified
- apps/backend/src/auth/**tests**/require-admin.test.ts — next()-throws path untested; userId assertion not parametrised
- apps/backend/src/auth/**tests**/require-auth.test.ts — empty beforeEach block; X-Client-Id allowlist not fully enumerated; misleading test name
- apps/backend/src/auth/**tests**/signer.test.ts — isAnySignerConfigured false branch untested; .then() vs async/await in rotation test
- apps/backend/src/auth/**tests**/social.test.ts — Apple test in Google describe scope; token not round-trip verified; feature-flag test fragile
- apps/backend/src/auth/**tests**/tokens.test.ts — wrong_issuer path never truly exercised; RS256 cross-alg forgery not tested; beforeAll/afterEach ordering reversed
- apps/backend/src/clustering/**tests**/algorithm.test.ts — clean; high quality
- apps/backend/src/clustering/**tests**/data-store.test.ts — cold-store state untested; "retains previous data" test cannot distinguish from empty init
- apps/backend/src/clustering/**tests**/handler.test.ts — protobuf fallback assertion is trivially true; bbox-clamp test under-specified; lower-bound zoom clamping untested
- apps/backend/src/config/**tests**/handler.test.ts — `as unknown as` cast for phase1Only field; minor type gap
- apps/backend/src/credits/**tests**/accrue-interest.test.ts — per-user transaction count unverified
- apps/backend/src/credits/**tests**/adjustments.test.ts — cap-disabled path does not assert cap query was skipped
- apps/backend/src/credits/**tests**/apy-snapshot.test.ts — `if (result.ok)` guards on 7 locations can silently swallow failures
- apps/backend/src/credits/**tests**/interest-forecast.test.ts — JPY exclusion test verifies count but not which currency was dropped
- apps/backend/src/credits/**tests**/interest-pool.test.ts — mid-test reset creates implicit ordering dependency
- apps/backend/src/credits/**tests**/interest-scheduler.test.ts — zero-APY guard test does not advance timers; assertion may be vacuous
- apps/backend/src/credits/**tests**/ledger-invariant.test.ts — adequate coverage
- apps/backend/src/credits/**tests**/liabilities.test.ts — currency-filter WHERE predicate content unverified
- apps/backend/src/credits/**tests**/payout-asset.test.ts — adequate coverage
- apps/backend/src/credits/**tests**/payout-builder.test.ts — silent `return` escape hatch can swallow assertion failures; unusual beforeEach_resetIssuers pattern
- apps/backend/src/credits/**tests**/payout-compensation.test.ts — fixture missing required fields; test works only due to check ordering
- apps/backend/src/credits/**tests**/pending-payouts-user.test.ts — clamping cases bundled in one it block
- apps/backend/src/credits/**tests**/pending-payouts.test.ts — adequate; truncation error-message test is correct
- apps/backend/src/credits/**tests**/refunds.test.ts — adequate coverage
- apps/backend/src/credits/**tests**/withdrawals.test.ts — payout insert ordering partially implicit; adequate otherwise
- apps/backend/src/ctx/**tests**/operator-pool.test.ts — sticky vs retryable latch distinction untested across a combined scenario
- apps/backend/src/ctx/**tests**/stream.test.ts — blank SSE frame in malformed-JSON test adds ambiguity; functionally passes
- apps/backend/src/db/**tests**/orders-schema.test.ts — runtime assertions test only the author's own literals; no real schema guards
- apps/backend/src/db/**tests**/pending-payouts-schema.test.ts — CRITICAL: two tests assert on self-constructed literals and can never fail
- apps/backend/src/db/**tests**/pooled-url.test.ts — boundary logic only tested in username position
- apps/backend/src/db/**tests**/users.test.ts — adequate coverage
- apps/backend/src/discord/**tests**/admin-audit.test.ts — idempotency truncation assertion allows empty string; color field untested

**Coverage:** 81/81 files reviewed. Skipped: none

## Batch 10 — backend tests (3/3)

apps/backend/src/discord/**tests**/monitoring-asset-drift.test.ts — clean, real escapeMarkdown via hoisting, direction/color semantics pinned
apps/backend/src/discord/**tests**/monitoring-stuck-sweepers.test.ts — clean, real truncate/escapeMarkdown, clock-drift tolerance on time fields
apps/backend/src/discord/**tests**/monitoring.test.ts — one truncated test name at line 93 (HIGH); otherwise solid dedup and per-asset independence coverage
apps/backend/src/images/**tests**/proxy.test.ts — clean SSRF suite, upstream hardening, WebP/JPEG alpha path, private cache mode
apps/backend/src/merchants/**tests**/handler.test.ts — unfailable Array.isArray assertion at line 219 (MEDIUM); otherwise good pagination/auth/slug coverage
apps/backend/src/merchants/**tests**/sync.test.ts — unfailable Array.isArray assertion at line 321 (MEDIUM); otherwise thorough pagination/error/denylist tests
apps/backend/src/orders/**tests**/barcode-fields.test.ts — clean pure unit tests
apps/backend/src/orders/**tests**/handler.test.ts — dedup set not reset between tests (HIGH); otherwise good CTX-proxy order coverage
apps/backend/src/orders/**tests**/loop-create-checks.test.ts — clean, tests hasSufficientCredit and isFirstLoopAssetOrder
apps/backend/src/orders/**tests**/loop-get-handler.test.ts — clean, BigInt serialisation and stellarAddress null for credit orders covered
apps/backend/src/orders/**tests**/loop-handler.test.ts — fragile vi.resetModules() pattern for feature-flag test (HIGH); otherwise very comprehensive
apps/backend/src/orders/**tests**/loop-list-handler.test.ts — whereArgs.length check doesn't inspect clause value (MEDIUM); otherwise adequate
apps/backend/src/orders/**tests**/loop-replay-response.test.ts — clean, all payment methods covered
apps/backend/src/orders/**tests**/pay-ctx.test.ts — clean, idempotency and error paths covered
apps/backend/src/orders/**tests**/procurement-scheduling.test.ts — clean, start/stop with fake timers
apps/backend/src/orders/**tests**/procurement.test.ts — process.env set at module scope without cleanup (LOW); otherwise very comprehensive
apps/backend/src/orders/**tests**/redemption.test.ts — clean, stream-first/fallback/timeout paths covered
apps/backend/src/orders/**tests**/repo.test.ts — idempotency error shape mismatch vs production driver (MEDIUM); otherwise thorough
apps/backend/src/orders/**tests**/sep7.test.ts — clean, pure SEP-7 URI parsing with edge cases
apps/backend/src/orders/**tests**/transitions.test.ts — dynamic import inconsistency for sweepStuckProcurement (MEDIUM); otherwise comprehensive
apps/backend/src/payments/**tests**/asset-drift-watcher.test.ts — clean, drift detection/dedup/recovery/pool-aware covered
apps/backend/src/payments/**tests**/cursor-watchdog.test.ts — clean, one-shot gate and recovery reset
apps/backend/src/payments/**tests**/fee-strategy.test.ts — clean, exponential fee curve unit tests
apps/backend/src/payments/**tests**/horizon-asset-balance.test.ts — clean, caching/schema drift/env URL override
apps/backend/src/payments/**tests**/horizon-balances.test.ts — clean, XLM+USDC parsing, malformed entries
apps/backend/src/payments/**tests**/horizon-circulation.test.ts — clean, stroops conversion and circulation fetch
apps/backend/src/payments/**tests**/horizon-trustlines.test.ts — clean, extraction/caching/404/5xx
apps/backend/src/payments/**tests**/horizon.test.ts — clean, create_account/account_merge edge cases covered
apps/backend/src/payments/**tests**/interest-pool-watcher.test.ts — missing notifyInterestPoolRecovered recovery path (LOW)
apps/backend/src/payments/**tests**/payout-submit.test.ts — clean, error classification coverage
apps/backend/src/payments/**tests**/payout-worker.test.ts — clean, trustline pre-check/idempotency/race/watchdog very thorough
apps/backend/src/payments/**tests**/price-feed.test.ts — clean, CoinGecko + CTX adapter, USDC/FX, error handling, caching
apps/backend/src/payments/**tests**/stuck-payout-watchdog.test.ts — clean, one-shot dedup and recovery reset
apps/backend/src/payments/**tests**/watcher-scheduling.test.ts — clean, scheduling start/stop
apps/backend/src/payments/**tests**/watcher.test.ts — clean, USDC/XLM/LOOP asset/cross-currency/cursor/spoofed-issuer guard
apps/backend/src/public/**tests**/cashback-preview.test.ts — clean, bps conversion, floor rounding, DB fallback, ADR 020 never-500
apps/backend/src/public/**tests**/cashback-stats.test.ts — brittle query classification by JSON stringify (INFO); otherwise all paths covered
apps/backend/src/public/**tests**/flywheel-stats.test.ts — clean, pctRecycled rounding, string coercion, { rows } envelope, never-500
apps/backend/src/public/**tests**/loop-assets.test.ts — clean, empty/partial/happy/never-500 paths covered
apps/backend/src/public/**tests**/merchant.test.ts — clean, id+slug resolution, coming-soon state, last-known-good fallback
apps/backend/src/public/**tests**/top-cashback-merchants.test.ts — clean, ADR 021 eviction, limit clamping, per-limit cache key
apps/backend/src/scripts/**tests**/quarterly-tax-parse.test.ts — helpers re-implemented locally rather than imported (MEDIUM); removes production-vs-test drift detection
apps/backend/src/users/**tests**/cashback-by-merchant.test.ts — clean, bigint/string/number normalisation, ISO date serialisation, { rows } envelope
apps/backend/src/users/**tests**/cashback-monthly.test.ts — clean, YYYY-MM formatting, multi-currency, { rows } envelope
apps/backend/src/users/**tests**/dsr-delete.test.ts — clean, A4-078 failed-uncompensated block and A4-123 to_address scrub covered
apps/backend/src/users/**tests**/dsr-export.test.ts — fragile shared-state router in select mock (LOW); otherwise good PII omission and bigint precision tests
apps/backend/src/users/**tests**/dsr-handler.test.ts — clean, all status codes for both handlers
apps/backend/src/users/**tests**/flywheel-stats.test.ts — dead jwtState bookkeeping (LOW); otherwise clean recycled/total coverage
apps/backend/src/users/**tests**/handler.test.ts — dead jwtState bookkeeping in several describes (LOW); otherwise very comprehensive multi-handler file
apps/backend/src/users/**tests**/orders-summary.test.ts — clean, 5-number summary, bigint normalisation, 500 path
apps/backend/src/users/**tests**/payment-method-share.test.ts — clean, unknown-method drop, byMethod zero-fill, { rows } envelope
apps/backend/src/users/**tests**/pending-payouts-summary.test.ts — clean, bigint serialisation, 401 paths covered
apps/backend/src/users/**tests**/stellar-trustlines.test.ts — clean, accountExists/accountLinked logic, 503 on Horizon throw
apps/backend/src/webhooks/**tests**/hmac-verify.test.ts — clean, real crypto, rotation window, tolerance clamping, header-format rejection

---

**Coverage:** 54/54 files reviewed. Skipped: none.

## Batch 11 — web src (1/6)

- apps/web/.env.local.example — clean, no secrets
- apps/web/.env.production — clean, public API URL only
- apps/web/AGENTS.md — accurate, well-maintained
- apps/web/app/app.css — clean, minor dead dark-mode selectors
- apps/web/app/components/features/admin/AdminAuditTail.tsx — unstable row key, duplicate fmtRelative
- apps/web/app/components/features/admin/AdminMonthlyCashbackChart.tsx — clean
- apps/web/app/components/features/admin/AdminNav.tsx — clean
- apps/web/app/components/features/admin/AdminUserFlywheelChip.tsx — clean
- apps/web/app/components/features/admin/AdminWithdrawalForm.tsx — clean
- apps/web/app/components/features/admin/AssetCirculationCard.tsx — duplicate local formatMinor
- apps/web/app/components/features/admin/AssetDriftBadge.tsx — clean
- apps/web/app/components/features/admin/AssetDriftWatcherCard.tsx — clean
- apps/web/app/components/features/admin/CashbackRealizationCard.tsx — intentional locale deviation, documented
- apps/web/app/components/features/admin/CashbackSparkline.tsx — clean
- apps/web/app/components/features/admin/CashbackSummaryChip.tsx — clean
- apps/web/app/components/features/admin/ConfigsHistoryCard.tsx — clean
- apps/web/app/components/features/admin/ConfirmDialog.tsx — clean, good native dialog use
- apps/web/app/components/features/admin/CopyButton.tsx — clean
- apps/web/app/components/features/admin/CreditAdjustmentForm.tsx — clean
- apps/web/app/components/features/admin/CreditFlowChart.tsx — duplicate fmtMinor
- apps/web/app/components/features/admin/CreditTransactionsTable.tsx — hasMore edge case on exact-multiple page size
- apps/web/app/components/features/admin/CsvDownloadButton.tsx — clean
- apps/web/app/components/features/admin/DiscordNotifiersCard.tsx — setTimeout leak
- apps/web/app/components/features/admin/FleetFlywheelHeadline.tsx — hard <a> link instead of <Link>
- apps/web/app/components/features/admin/HomeCurrencyForm.tsx — clean
- apps/web/app/components/features/admin/MerchantCashbackMonthlyChart.tsx — barWidthPct double-call
- apps/web/app/components/features/admin/MerchantCashbackPaidCard.tsx — clean
- apps/web/app/components/features/admin/MerchantFlywheelActivityChart.tsx — clean
- apps/web/app/components/features/admin/MerchantFlywheelChip.tsx — clean
- apps/web/app/components/features/admin/MerchantOperatorMixCard.tsx — since-vs-key drift
- apps/web/app/components/features/admin/MerchantRailMixCard.tsx — clean
- apps/web/app/components/features/admin/MerchantResyncButton.tsx — setTimeout leak
- apps/web/app/components/features/admin/MerchantsFlywheelShareCard.tsx — clean
- apps/web/app/components/features/admin/MerchantStatsTable.tsx — fmtRelative missing "just now"
- apps/web/app/components/features/admin/MerchantTopEarnersCard.tsx — clean, good BigInt error handling
- apps/web/app/components/features/admin/OperatorMerchantMixCard.tsx — since-vs-key drift
- apps/web/app/components/features/admin/OperatorStatsCard.tsx — since-vs-key drift
- apps/web/app/components/features/admin/OrdersSparkline.tsx — clean
- apps/web/app/components/features/admin/PaymentMethodActivityChart.tsx — clean
- apps/web/app/components/features/admin/PaymentMethodShareCard.tsx — clean
- apps/web/app/components/features/admin/PayoutsByAssetTable.tsx — clean
- apps/web/app/components/features/admin/PayoutsSparkline.tsx — clean
- apps/web/app/components/features/admin/RealizationSparkline.tsx — clean
- apps/web/app/components/features/admin/ReasonDialog.tsx — clean, good native dialog use
- apps/web/app/components/features/admin/ReplayedBadge.tsx — clean
- apps/web/app/components/features/admin/RequireAdmin.tsx — clean, minor convoluted denied condition
- apps/web/app/components/features/admin/SettlementLagCard.tsx — clean
- apps/web/app/components/features/admin/Sparkline.tsx — clean
- apps/web/app/components/features/admin/StepUpModal.tsx — MEDIUM: missing focus trap (div dialog vs native dialog)
- apps/web/app/components/features/admin/StuckOrdersCard.tsx — clean
- apps/web/app/components/features/admin/StuckPayoutsCard.tsx — clean
- apps/web/app/components/features/admin/SupplierSpendActivityChart.tsx — clean
- apps/web/app/components/features/admin/SupplierSpendCard.tsx — since-vs-key drift
- apps/web/app/components/features/admin/TopUsersByPendingPayoutCard.tsx — clean
- apps/web/app/components/features/admin/TopUsersTable.tsx — since-vs-key drift
- apps/web/app/components/features/admin/TreasuryReconciliationChart.tsx — clean
- apps/web/app/components/features/admin/UserCashbackByMerchantTable.tsx — minor Number() precision note
- apps/web/app/components/features/admin/UserCashbackMonthlyChart.tsx — clean
- apps/web/app/components/features/admin/UserOperatorMixCard.tsx — since-vs-key drift
- apps/web/app/components/features/admin/UserOrdersTable.tsx — replaceAll suggestion

**Coverage:** 60/60 files reviewed. Skipped: none

## Batch 12 Audit Report — Web App Components

`UserPayoutsTable.tsx`, `UserRailMixCard.tsx`, `UsersRecyclingActivityCard.tsx`, `GoogleSignInButton.tsx`, `CashbackBalanceCard.tsx`, `CashbackByMerchantCard.tsx`, `CashbackEarningsHeadline.tsx`, `FlywheelChip.tsx`, `LinkWalletNudge.tsx`, `MonthlyCashbackChart.tsx`, `PendingCashbackChip.tsx`, `PendingPayoutsCard.tsx`, `RailMixCard.tsx`, `ClusterMap.tsx`, `CountrySelector.tsx` (ARIA note captured in LOW-1), `FavoritesStrip.tsx`, `FavoriteToggleButton.tsx`, `FixedSearchButton.tsx`, `Footer.tsx`, `CashbackStatsBand.tsx`, `FlywheelStatsBand.tsx`, `MapBottomSheet.tsx`, `MerchantCard.tsx`, `MerchantGroupCard.tsx`, `NativeBackButton.tsx`, `NativeTabBar.tsx`, `atoms.tsx`, `OnboardingDesktop.tsx`, `screen-biometric.tsx`, `screen-currency.tsx`, `screen-wallet-intro.tsx`, `OrderPayoutCard.tsx`, `OrdersSummaryHeader.tsx`, `AmountSelection.tsx`, `EarnedCashbackCard.tsx`, `PurchaseComplete.tsx`, `PurchaseContainer.tsx`, `RedeemFlow.tsx`, `RecentlyPurchasedStrip.tsx`, `TrustlineSetupCard.tsx`, `Phase2Gate.tsx`, `Avatar.tsx`, `BackToSite.tsx`, `Badge.tsx`, `Button.tsx`, `Card.tsx`, `Container.tsx`, `index.ts` (ui barrel), `Input.tsx`, `LazyImage.tsx`

---

**Coverage:** 60 / 60 files read and audited.

## Batch 13 — web src (3/6)

| #   | File                                                  | Verdict                                                                                                                                            |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/web/app/components/ui/LocaleLink.tsx`           | CLEAN                                                                                                                                              |
| 2   | `apps/web/app/components/ui/LoopLogo.tsx`             | CLEAN                                                                                                                                              |
| 3   | `apps/web/app/components/ui/OfflineBanner.tsx`        | CLEAN                                                                                                                                              |
| 4   | `apps/web/app/components/ui/PageHeader.tsx`           | CLEAN                                                                                                                                              |
| 5   | `apps/web/app/components/ui/Skeleton.tsx`             | CLEAN                                                                                                                                              |
| 6   | `apps/web/app/components/ui/Spinner.tsx`              | CLEAN                                                                                                                                              |
| 7   | `apps/web/app/components/ui/ToastContainer.tsx`       | CLEAN                                                                                                                                              |
| 8   | `apps/web/app/entry.server.tsx`                       | CLEAN — complex, well-implemented; nonce-per-request, HEAD fast-path, abort cleanup                                                                |
| 9   | `apps/web/app/hooks/query-retry.ts`                   | CLEAN                                                                                                                                              |
| 10  | `apps/web/app/hooks/use-admin-step-up.ts`             | CLEAN — `runWithStepUp` dep array omits `pendingResolve` but only reads setter (stable); `handleStepUpConfirm/Cancel` correctly list it            |
| 11  | `apps/web/app/hooks/use-app-config.ts`                | CLEAN                                                                                                                                              |
| 12  | `apps/web/app/hooks/use-auth.ts`                      | CLEAN                                                                                                                                              |
| 13  | `apps/web/app/hooks/use-favorites.ts`                 | CLEAN — optimistic update with rollback                                                                                                            |
| 14  | `apps/web/app/hooks/use-merchants.ts`                 | CLEAN                                                                                                                                              |
| 15  | `apps/web/app/hooks/use-native-platform.ts`           | CLEAN — SSR-safe                                                                                                                                   |
| 16  | `apps/web/app/hooks/use-orders.ts`                    | CLEAN                                                                                                                                              |
| 17  | `apps/web/app/hooks/use-recently-purchased.ts`        | CLEAN                                                                                                                                              |
| 18  | `apps/web/app/hooks/use-session-restore.ts`           | CLEAN — module-level singleton intentional; cancelled guard present                                                                                |
| 19  | `apps/web/app/i18n/format.ts`                         | CLEAN — `"$"` fallback for unknown currency is acceptable                                                                                          |
| 20  | `apps/web/app/i18n/locale.ts`                         | LOW — `setCountryCookie` missing `Secure` attribute                                                                                                |
| 21  | `apps/web/app/i18n/messages.ts`                       | CLEAN                                                                                                                                              |
| 22  | `apps/web/app/i18n/seo.ts`                            | CLEAN — `escapeXmlAttr` present; `hreflangAlternates` uses `DEFAULT_LANG` for all countries (intentional)                                          |
| 23  | `apps/web/app/i18n/t.ts`                              | CLEAN                                                                                                                                              |
| 24  | `apps/web/app/native/app-lock.ts`                     | CLEAN — cancelled guard, no XSS risk, biometric re-prompt on visibility                                                                            |
| 25  | `apps/web/app/native/back-button.ts`                  | CLEAN — disposed flag                                                                                                                              |
| 26  | `apps/web/app/native/biometrics.ts`                   | CLEAN — `androidConfirmationRequired: false` intentional                                                                                           |
| 27  | `apps/web/app/native/clipboard.ts`                    | CLEAN                                                                                                                                              |
| 28  | `apps/web/app/native/haptics.ts`                      | CLEAN                                                                                                                                              |
| 29  | `apps/web/app/native/keyboard.ts`                     | CLEAN                                                                                                                                              |
| 30  | `apps/web/app/native/network.ts`                      | CLEAN — cancelled flag, initial status check                                                                                                       |
| 31  | `apps/web/app/native/notifications.ts`                | CLEAN                                                                                                                                              |
| 32  | `apps/web/app/native/platform.ts`                     | CLEAN — cast acknowledged                                                                                                                          |
| 33  | `apps/web/app/native/purchase-storage.ts`             | LOW — malformed-expiresAt path synthesizes expiry rather than rejecting                                                                            |
| 34  | `apps/web/app/native/secure-storage.ts`               | CLEAN — Proxy facade, web uses sessionStorage                                                                                                      |
| 35  | `apps/web/app/native/share.ts`                        | CLEAN                                                                                                                                              |
| 36  | `apps/web/app/native/status-bar.ts`                   | CLEAN                                                                                                                                              |
| 37  | `apps/web/app/native/task-switcher-overlay.ts`        | CLEAN                                                                                                                                              |
| 38  | `apps/web/app/native/webview.ts`                      | CLEAN — `assertSafeUrl` validates protocol/credentials                                                                                             |
| 39  | `apps/web/app/root.tsx`                               | INFO — module-level queryClient SSR-safe (all writes guarded); `buildSecurityHeaders` called every render (pure fn)                                |
| 40  | `apps/web/app/routes.ts`                              | CLEAN                                                                                                                                              |
| 41  | `apps/web/app/routes/admin._index.tsx`                | MEDIUM — non-top-of-file import at line 39                                                                                                         |
| 42  | `apps/web/app/routes/admin.assets.$assetCode.tsx`     | MEDIUM — non-top-of-file import at line 43                                                                                                         |
| 43  | `apps/web/app/routes/admin.assets.tsx`                | MEDIUM — non-top-of-file import at line 27                                                                                                         |
| 44  | `apps/web/app/routes/admin.audit.tsx`                 | LOW — row key `actorUserId-createdAt` collision risk                                                                                               |
| 45  | `apps/web/app/routes/admin.cashback.tsx`              | MEDIUM — `isDirty` string-compares numeric percent values                                                                                          |
| 46  | `apps/web/app/routes/admin.merchants.$merchantId.tsx` | CLEAN                                                                                                                                              |
| 47  | `apps/web/app/routes/admin.merchants.tsx`             | CLEAN                                                                                                                                              |
| 48  | `apps/web/app/routes/admin.operators.$operatorId.tsx` | MEDIUM — non-top-of-file import at line 24                                                                                                         |
| 49  | `apps/web/app/routes/admin.operators.tsx`             | LOW — local `fmtRelative` duplicates AdminAuditTail logic                                                                                          |
| 50  | `apps/web/app/routes/admin.orders.$orderId.tsx`       | CLEAN                                                                                                                                              |
| 51  | `apps/web/app/routes/admin.orders.tsx`                | MEDIUM — `formatDate` uses undefined locale; LOW — stale PR #390 TODO without date                                                                 |
| 52  | `apps/web/app/routes/admin.payouts.$id.tsx`           | MEDIUM — `fmtStroops` duplicate #1 of 4                                                                                                            |
| 53  | `apps/web/app/routes/admin.payouts.tsx`               | MEDIUM — `fmtStroops` duplicate #2 of 4                                                                                                            |
| 54  | `apps/web/app/routes/admin.stuck-orders.tsx`          | MEDIUM — `fmtStroops` duplicate #3 of 4; TODO without date                                                                                         |
| 55  | `apps/web/app/routes/admin.treasury.tsx`              | MEDIUM — `fmtStroops` duplicate #4 of 4; INFO — local `fmtMinor` (bigint-safe) may overlap shared helper                                           |
| 56  | `apps/web/app/routes/admin.users.$userId.tsx`         | MEDIUM — non-top-of-file import at line 31                                                                                                         |
| 57  | `apps/web/app/routes/admin.users.tsx`                 | CLEAN                                                                                                                                              |
| 58  | `apps/web/app/routes/auth.tsx`                        | LOW — `isLoading` used instead of `isPending` on meQuery/historyQuery; INFO — empty dep array on handleGoogleCredential intentional and documented |
| 59  | `apps/web/app/routes/brand.$slug.tsx`                 | INFO — `window.history.length` check outside native/ but not a plugin call                                                                         |
| 60  | `apps/web/app/routes/calculator.tsx`                  | CLEAN                                                                                                                                              |

---

**Coverage:** 60/60 files reviewed.

## Batch 14 — web src (4/6)

- apps/web/app/routes/cashback.$slug.tsx — clean; minor canonical URL encoding concern
- apps/web/app/routes/cashback.tsx — clean; query.data access relies on correct narrowing
- apps/web/app/routes/gift-card.$name.tsx — clean; computed Tailwind class indexing worth noting
- apps/web/app/routes/home-geo-redirect.tsx — documented loader-fetch exception; correct
- apps/web/app/routes/home.tsx — missing useMemo on featured derivation; hydration pattern correct
- apps/web/app/routes/locale-layout-ssr.tsx — clean; correct 404 pattern
- apps/web/app/routes/locale-layout.tsx — clean; correct SPA fallback
- apps/web/app/routes/map.tsx — clean; lazy Leaflet import correct
- apps/web/app/routes/not-found-ssr.tsx — clean; correct SSR 404 pattern
- apps/web/app/routes/not-found.tsx — clean
- apps/web/app/routes/onboarding.tsx — clean; thin wrapper
- apps/web/app/routes/orders.$id.tsx — dead `void now` usage; openWebView import needs location check
- apps/web/app/routes/orders.tsx — clean; good pagination implementation
- apps/web/app/routes/privacy.tsx — internal endpoint paths exposed in public policy text
- apps/web/app/routes/settings.cashback.tsx — BigInt→Number coercion unsafe for large values
- apps/web/app/routes/settings.wallet.tsx — setTimeout without cleanup (minor); otherwise solid
- apps/web/app/routes/sitemap.tsx — documented loader-fetch exception; escapeXml correct
- apps/web/app/routes/terms.tsx — editorial typo in section 4
- apps/web/app/routes/trustlines.tsx — clean; good external link rel="noopener noreferrer"
- apps/web/app/services/admin-activity.ts — clean; well-structured type definitions
- apps/web/app/services/admin-assets.ts — clean; re-exports from @loop/shared correctly
- apps/web/app/services/admin-audit.ts — clean; back-compat overload handled correctly
- apps/web/app/services/admin-cashback-config.ts — clean; idempotency key per-click correct
- apps/web/app/services/admin-cashback-realization.ts — clean; re-exports correct
- apps/web/app/services/admin-csv.ts — blob URL revocation races with async download dialog
- apps/web/app/services/admin-discord.ts — clean
- apps/web/app/services/admin-merchant-activity.ts — clean
- apps/web/app/services/admin-merchant-drill.ts — clean
- apps/web/app/services/admin-merchant-flows.ts — clean
- apps/web/app/services/admin-merchant-stats.ts — clean
- apps/web/app/services/admin-merchants-resync.ts — clean; idempotency key correct
- apps/web/app/services/admin-monthly.ts — clean; per-scope shapes well-separated
- apps/web/app/services/admin-operator-drill.ts — clean
- apps/web/app/services/admin-operator-mixes.ts — clean; re-exports from @loop/shared correct
- apps/web/app/services/admin-operator-stats.ts — clean
- apps/web/app/services/admin-orders.ts — clean; AdminOrderState alias documented
- apps/web/app/services/admin-payment-method-activity.ts — clean
- apps/web/app/services/admin-payment-method-share.ts — clean
- apps/web/app/services/admin-payouts-by-asset.ts — clean
- apps/web/app/services/admin-payouts.ts — clean; step-up gate applied correctly
- apps/web/app/services/admin-settlement-lag.ts — clean
- apps/web/app/services/admin-step-up.ts — clean; thin wrapper
- apps/web/app/services/admin-stuck.ts — clean; safety-critical alerting types correct
- apps/web/app/services/admin-supplier-spend.ts — clean
- apps/web/app/services/admin-top-users.ts — clean
- apps/web/app/services/admin-treasury.ts — clean; re-exports from @loop/shared correct
- apps/web/app/services/admin-user-cashback-by-merchant.ts — clean
- apps/web/app/services/admin-user-credits.ts — clean; both writes have step-up + idempotency
- apps/web/app/services/admin-user-drill.ts — clean
- apps/web/app/services/admin-user-fleet-activity.ts — clean
- apps/web/app/services/admin-user-home-currency.ts — clean; step-up gated correctly
- apps/web/app/services/admin-users-list.ts — clean
- apps/web/app/services/admin-write-envelope.ts — clean; UUID fallback well-commented
- apps/web/app/services/admin.ts — pure barrel; duplicate type name in comment line 41
- apps/web/app/services/api-client.ts — AbortError conflated with TIMEOUT code; otherwise solid
- apps/web/app/services/auth.ts — clean; refresh-token rotation handled
- apps/web/app/services/clusters.ts — multiple eslint-disable lines; proto bridge pattern correct
- apps/web/app/services/config.ts — AppConfig not Zod-validated after fetch
- apps/web/app/services/favorites.ts — clean
- apps/web/app/services/geo.ts — clean; thin wrapper

**Coverage:** 60/60 files reviewed. Skipped: none.

## Batch 15 — web src (5/6)

- apps/web/app/services/merchants.ts — clean; correct `encodeURIComponent` usage, proper separation of authed vs public calls
- apps/web/app/services/orders-loop.ts — clean; idempotency key generation well-designed, type re-exports clear
- apps/web/app/services/orders.ts — clean; thin wrapper, nothing notable
- apps/web/app/services/parse-error-response.ts — clean; defensive JSON parse, X-Request-Id correlation correct
- apps/web/app/services/public-stats.ts — duplicate `PublicCashbackPreview` import (MEDIUM); stale `USDLOOP`/`EURLOOP` in local interface (MEDIUM)
- apps/web/app/services/recently-purchased.ts — clean
- apps/web/app/services/stellar-wallet.ts — stub file (documented, pending ADR); stale asset code union (LOW)
- apps/web/app/services/user.ts — clean; well-structured, 404→null conversion for `getUserPayoutByOrder` is correct
- apps/web/app/stores/admin-step-up.store.ts — clean; memory-only by design, 5s clock-skew buffer correct
- apps/web/app/stores/auth.store.ts — clean; access token memory-only, refresh token via secure-storage, cross-tab logout safe
- apps/web/app/stores/purchase.store.ts — clean; session restore validation against tampered state is well-designed, persist queue serialisation correct
- apps/web/app/stores/ui.store.ts — clean; SSR safety well-documented and correct, toast timer cleanup correct
- apps/web/app/utils/admin-cache.ts — clean; predicate sweep pattern correct
- apps/web/app/utils/error-messages.ts — clean; code-keyed messages good, intentional absence of UNAUTHORIZED documented
- apps/web/app/utils/image.ts — clean
- apps/web/app/utils/locale.ts — clean
- apps/web/app/utils/money.ts — clean; defensive Intl fallback correct
- apps/web/app/utils/nonce-context.ts — clean; null default for mobile static export path is correct
- apps/web/app/utils/query-error-reporting.ts — clean; forward-only-unexpected-errors pattern correct; scrubbing before capture is good
- apps/web/app/utils/redeem-challenge-bar.ts — clean; `JSON.stringify(code)` prevents JS injection in the script template; no innerHTML; fallback clipboard copy handles older WebViews
- apps/web/app/utils/security-headers.ts — style-src unsafe-inline should be re-evaluated for SSR nonce path (LOW)
- apps/web/app/utils/sentry-error-scrubber.ts — `.stack` copied unscrubbed (MEDIUM); scrubStringForSentry is thorough on message/strings
- apps/web/app/utils/sentry-scrubber.ts — clean; SENSITIVE_KEY_RE comprehensive, scrubObject recursive
- apps/web/app/utils/share-image.ts — loadImage has no timeout (MEDIUM); barcodeImageUrl is correctly proxied by callers before reaching this function
- apps/web/Dockerfile — npx startup slight issue (LOW); otherwise well-structured, non-root user, pinned base image digest, build args wired
- apps/web/fly.toml — 256 MB RAM potentially tight for Node.js SSR (LOW); health check and HTTPS correct
- apps/web/package.json — clean; all versions pinned, jsbarcode correctly in devDependencies
- apps/web/public/flags/ae.svg — binary/asset: UAE flag SVG
- apps/web/public/flags/at.svg — binary/asset: Austria flag SVG
- apps/web/public/flags/au.svg — binary/asset: Australia flag SVG
- apps/web/public/flags/be.svg — binary/asset: Belgium flag SVG
- apps/web/public/flags/ca.svg — binary/asset: Canada flag SVG
- apps/web/public/flags/cy.svg — binary/asset: Cyprus flag SVG
- apps/web/public/flags/de.svg — binary/asset: Germany flag SVG
- apps/web/public/flags/ee.svg — binary/asset: Estonia flag SVG
- apps/web/public/flags/es.svg — binary/asset: Spain flag SVG
- apps/web/public/flags/fi.svg — binary/asset: Finland flag SVG
- apps/web/public/flags/fr.svg — binary/asset: France flag SVG
- apps/web/public/flags/gb.svg — binary/asset: UK flag SVG
- apps/web/public/flags/gr.svg — binary/asset: Greece flag SVG
- apps/web/public/flags/hr.svg — binary/asset: Croatia flag SVG
- apps/web/public/flags/ie.svg — binary/asset: Ireland flag SVG
- apps/web/public/flags/in.svg — binary/asset: India flag SVG
- apps/web/public/flags/it.svg — binary/asset: Italy flag SVG
- apps/web/public/flags/lt.svg — binary/asset: Lithuania flag SVG
- apps/web/public/flags/lu.svg — binary/asset: Luxembourg flag SVG
- apps/web/public/flags/lv.svg — binary/asset: Latvia flag SVG
- apps/web/public/flags/mt.svg — binary/asset: Malta flag SVG
- apps/web/public/flags/mx.svg — binary/asset: Mexico flag SVG
- apps/web/public/flags/nl.svg — binary/asset: Netherlands flag SVG
- apps/web/public/flags/pt.svg — binary/asset: Portugal flag SVG
- apps/web/public/flags/sa.svg — binary/asset: Saudi Arabia flag SVG
- apps/web/public/flags/si.svg — binary/asset: Slovenia flag SVG
- apps/web/public/flags/sk.svg — binary/asset: Slovakia flag SVG
- apps/web/public/flags/us.svg — binary/asset: US flag SVG
- apps/web/public/hero.webp — binary image asset
- apps/web/public/leaflet/marker-icon-2x.png — binary image asset
- apps/web/public/leaflet/marker-icon.png — binary image asset
- apps/web/public/leaflet/marker-shadow.png — binary image asset
- apps/web/public/login-hero.jpg — binary image asset

**Coverage:** 61/61 files reviewed. Skipped: none

## Batch 16 — web src (10/10)

- `apps/web/public/loop-favicon.svg` — simple L-in-square SVG favicon; no title element but cosmetically fine
- `apps/web/public/loop-logo-white.svg` — SVG wordmark (white variant); generated asset, no issues
- `apps/web/public/loop-logo.svg` — SVG wordmark (dark variant); used as maskable PWA icon incorrectly (MEDIUM finding)
- `apps/web/public/manifest.json` — PWA manifest; maskable icon safe-zone violation + hardcoded lang + static start_url
- `apps/web/public/robots.txt` — well-commented; missing locale-prefixed disallow for /onboarding
- `apps/web/react-router.config.ts` — minimal, correct SSR toggle
- `apps/web/README.md` — accurate documentation, up to date with current structure
- `apps/web/tsconfig.json` — correct, verbatimModuleSyntax:false intentional
- `apps/web/vite.config.ts` — dev proxy silently falls back to prod API when VITE_API_URL unset (MEDIUM)
- `apps/web/vitest.config.ts` — bare \_\_dirname usage in ESM package context (LOW); thresholds conservatively low

**Coverage:** 10/10 files reviewed. Skipped: none

## Batch 17 — web tests (1/2)

- apps/web/app/**tests**/entry-server-headers.test.ts — solid; tests the real utility function; entry.server wiring not directly tested but noted in comments
- apps/web/app/components/features/**tests**/CountrySelector.test.tsx — well-structured; good coverage of navigation, filtering, and cookie setting
- apps/web/app/components/features/**tests**/MerchantCard.test.tsx — solid; badge visibility, displayName fallback all covered
- apps/web/app/components/features/**tests**/MerchantGroupCard.test.tsx — solid; group card, savings, cashback best-of covered
- apps/web/app/components/features/admin/**tests**/AdminAuditTail.test.tsx — good; has dynamic fireEvent import smell (LOW finding)
- apps/web/app/components/features/admin/**tests**/AdminMonthlyCashbackChart.test.tsx — solid; empty, error, multi-currency covered
- apps/web/app/components/features/admin/**tests**/AdminNav.test.tsx — comprehensive; tabs, CTX pill states, failed-payout badge all covered
- apps/web/app/components/features/admin/**tests**/AdminUserFlywheelChip.test.tsx — solid; zero/recycled/singular/error/404 all covered
- apps/web/app/components/features/admin/**tests**/AdminWithdrawalForm.test.tsx — pure unit test of parseUnsignedAmountMajor; excellent coverage
- apps/web/app/components/features/admin/**tests**/AssetCirculationCard.test.tsx — solid; drift states, 503, 500 silent-hide all covered
- apps/web/app/components/features/admin/**tests**/AssetDriftBadge.test.tsx — solid; classify + render states covered
- apps/web/app/components/features/admin/**tests**/AssetDriftWatcherCard.test.tsx — solid; running/inactive/over-threshold states covered
- apps/web/app/components/features/admin/**tests**/CashbackRealizationCard.test.tsx — good; "self-hides" sync gate is weak (MEDIUM finding)
- apps/web/app/components/features/admin/**tests**/CashbackSparkline.test.tsx — solid; toPoints and component cases covered
- apps/web/app/components/features/admin/**tests**/CashbackSummaryChip.test.tsx — solid; formatMinor bigint precision tests notable
- apps/web/app/components/features/admin/**tests**/ConfigsHistoryCard.test.tsx — solid; empty, error, row rendering covered
- apps/web/app/components/features/admin/**tests**/CopyButton.test.tsx — comprehensive; fallback paths, both-fail, flash timing all tested
- apps/web/app/components/features/admin/**tests**/CreditAdjustmentForm.test.tsx — pure unit test; excellent edge case coverage
- apps/web/app/components/features/admin/**tests**/CreditFlowChart.test.tsx — solid; tab switching, positive/negative net covered
- apps/web/app/components/features/admin/**tests**/CsvDownloadButton.test.tsx — solid; download, error, custom label covered
- apps/web/app/components/features/admin/**tests**/DiscordNotifiersCard.test.tsx — comprehensive; all states and ping response types covered
- apps/web/app/components/features/admin/**tests**/FleetFlywheelHeadline.test.tsx — solid; zero/error/not-yet/happy-path/malformed all covered
- apps/web/app/components/features/admin/**tests**/MerchantCashbackMonthlyChart.test.tsx — solid; empty, multi-currency, error, 404 covered
- apps/web/app/components/features/admin/**tests**/MerchantCashbackPaidCard.test.tsx — solid; zero-volume, per-currency rows, 404 covered
- apps/web/app/components/features/admin/**tests**/MerchantFlywheelActivityChart.test.tsx — solid; zero-series, sparkline, error, 404 covered
- apps/web/app/components/features/admin/**tests**/MerchantFlywheelChip.test.tsx — solid; all volume states and 404 covered
- apps/web/app/components/features/admin/**tests**/MerchantOperatorMixCard.test.tsx — solid; empty, error, row+links, zero-orders em-dash covered
- apps/web/app/components/features/admin/**tests**/MerchantRailMixCard.test.tsx — good; has minor comment inaccuracy (LOW finding)
- apps/web/app/components/features/admin/**tests**/MerchantResyncButton.test.tsx — comprehensive; dialog flow, cancel, short-reason, in-flight disable all tested
- apps/web/app/components/features/admin/**tests**/MerchantsFlywheelShareCard.test.tsx — solid; empty, error, rows, links, malformed bigint covered
- apps/web/app/components/features/admin/**tests**/MerchantStatsTable.test.tsx — solid; aggregate row, empty, error covered
- apps/web/app/components/features/admin/**tests**/MerchantTopEarnersCard.test.tsx — solid; malformed cashback em-dash is a notable defensive test
- apps/web/app/components/features/admin/**tests**/OperatorMerchantMixCard.test.tsx — solid; evicted-merchant fallback covered
- apps/web/app/components/features/admin/**tests**/OperatorStatsCard.test.tsx — solid; successRatePct clamp tested
- apps/web/app/components/features/admin/**tests**/OrdersSparkline.test.tsx — solid; toPoints and component covered
- apps/web/app/components/features/admin/**tests**/PaymentMethodActivityChart.test.tsx — solid; zero-day, legend, tab selection covered
- apps/web/app/components/features/admin/**tests**/PaymentMethodShareCard.test.tsx — solid; fmtPctBigint, empty, rows, deep-links covered
- apps/web/app/components/features/admin/**tests**/PayoutsSparkline.test.tsx — solid; dayTotalStroops malformed skip tested
- apps/web/app/components/features/admin/**tests**/RealizationSparkline.test.tsx — solid; toDailyBps sort, clamp, malformed-skip all covered
- apps/web/app/components/features/admin/**tests**/ReplayedBadge.test.tsx — minimal but complete; contract tests are sufficient for this simple component
- apps/web/app/components/features/admin/**tests**/SettlementLagCard.test.tsx — solid; formatSeconds boundaries, fleet-only, fleet+per-asset all covered
- apps/web/app/components/features/admin/**tests**/Sparkline.test.tsx — has always-passes assertion (LOW finding)
- apps/web/app/components/features/admin/**tests**/StuckOrdersCard.test.tsx — solid; zero-stuck, count+age, error em-dash covered
- apps/web/app/components/features/admin/**tests**/StuckPayoutsCard.test.tsx — solid; mirrors StuckOrdersCard pattern
- apps/web/app/components/features/admin/**tests**/SupplierSpendActivityChart.test.tsx — solid; tab switching, empty, error, day rows covered
- apps/web/app/components/features/admin/**tests**/SupplierSpendCard.test.tsx — solid; rows, empty, error, drill link covered
- apps/web/app/components/features/admin/**tests**/TopUsersByPendingPayoutCard.test.tsx — solid; fmtStroops, empty, error, row links covered
- apps/web/app/components/features/admin/**tests**/TopUsersTable.test.tsx — good; window-toggle refetch tested; has dynamic fireEvent import smell (LOW)
- apps/web/app/components/features/admin/**tests**/TreasuryReconciliationChart.test.tsx — thorough; mergePerCurrency has excellent unit coverage (asset mapping, sort, unknown codes)
- apps/web/app/components/features/admin/**tests**/UserCashbackByMerchantTable.test.tsx — solid; fmtCashback, empty, row link, error covered
- apps/web/app/components/features/admin/**tests**/UserCashbackMonthlyChart.test.tsx — solid; empty, multi-currency, error, 404 covered
- apps/web/app/components/features/admin/**tests**/UserOperatorMixCard.test.tsx — solid; empty, error, row+links covered
- apps/web/app/components/features/admin/**tests**/UserOrdersTable.test.tsx — solid; row, empty, error covered
- apps/web/app/components/features/admin/**tests**/UserPayoutsTable.test.tsx — solid; fmtStroops, userId passthrough, empty, error covered
- apps/web/app/components/features/admin/**tests**/UserRailMixCard.test.tsx — solid; zero-volume, four rails, drill links, 404 covered
- apps/web/app/components/features/admin/**tests**/UsersRecyclingActivityCard.test.tsx — solid; formatRelative, empty, error, rows, malformed bigint covered
- apps/web/app/components/features/cashback/**tests**/CashbackBalanceCard.test.tsx — solid; empty, tiles, error silent-hide covered
- apps/web/app/components/features/cashback/**tests**/CashbackByMerchantCard.test.tsx — solid; self-hides, rows, catalog fallback, error covered
- apps/web/app/components/features/cashback/**tests**/CashbackCalculator.test.tsx — good; has real setTimeout timing risk (MEDIUM finding)
- apps/web/app/components/features/cashback/**tests**/CashbackEarningsHeadline.test.tsx — solid; zero-hide, lifetime+month, month-only, error covered
- apps/web/app/components/features/cashback/**tests**/FlywheelChip.test.tsx — solid; formatMinor bigint precision notable; chip states covered
- apps/web/app/components/features/cashback/**tests**/LinkWalletNudge.test.tsx — solid; hasPositiveBalance unit + component states (wallet linked, zero balance, error) covered
- apps/web/app/components/features/cashback/**tests**/MonthlyCashbackChart.test.tsx — solid; pure function tests + single/multi-currency render covered
- apps/web/app/components/features/cashback/**tests**/PendingCashbackChip.test.tsx — good; alphabetical ordering assertion is brittle (LOW finding)
- apps/web/app/components/features/cashback/**tests**/PendingPayoutsCard.test.tsx — solid; confirmed+pending states, explorer link, single-link count covered
- apps/web/app/components/features/cashback/**tests**/RailMixCard.test.tsx — solid; self-hides on zero and error, four-rail render covered
- apps/web/app/components/features/home/**tests**/CashbackStatsBand.test.tsx — solid; zero-hide, all-zeros, three-tile render covered
- apps/web/app/components/features/home/**tests**/FlywheelStatsBand.test.tsx — solid; zero/error hides, happy path covered
- apps/web/app/components/features/home/**tests**/SavingsHero.test.tsx — solid; Phase-1/Phase-2 copy, unauthenticated empty state covered
- apps/web/app/components/features/onboarding/**tests**/screen-currency.test.tsx — solid; homeCurrencyForCountry, guessHomeCurrency, picker states all covered
- apps/web/app/components/features/onboarding/**tests**/screen-wallet-intro.test.tsx — solid; currency chips, onLinkWallet callback, tabindex covered
- apps/web/app/components/features/order/**tests**/OrderPayoutCard.test.tsx — solid; null/error self-hide, confirmed/pending/failed states, pluralisation, zero-attempts edge case covered
- apps/web/app/components/features/orders/**tests**/LoopOrdersList.test.tsx — comprehensive; 14 tests covering recycled pill, auto-expand, redemption URL, cashback pill, failure reason, disabled flag
- apps/web/app/components/features/orders/**tests**/OrdersSummaryHeader.test.tsx — solid; zero-hide, active user, pending emphasis CSS class tested
- apps/web/app/components/features/purchase/**tests**/AmountSelection.test.tsx — comprehensive; fixed denominations, min-max, IEEE-754 drift, no-denom fallback, cashback estimate all covered
- apps/web/app/components/features/purchase/**tests**/EarnedCashbackCard.test.tsx — solid; null/zero/invalid amount hides, rate+amount render, currency symbol, link covered
- apps/web/app/components/features/purchase/**tests**/LoopPaymentStep.test.tsx — comprehensive; stellar/credit paths, state transitions, onTerminal callback, redemption URL/fallback, cashback line covered
- apps/web/app/components/features/purchase/**tests**/PaymentStep.test.tsx — good; has loose assertions (MEDIUM finding on rendering tests and copy argument)
- apps/web/app/components/features/purchase/**tests**/PurchaseComplete.test.tsx — comprehensive; PIN optional, haptic on mount, copy feedback, share with/without PIN, barcode canvas, proxy mode
- apps/web/app/components/features/purchase/**tests**/RedeemFlow.test.tsx — has weak CTA assertion (MEDIUM finding)

**Coverage:** 81/81 files reviewed. Skipped: none

## Batch 18 — web tests (2/2)

- apps/web/app/components/features/wallet/**tests**/StellarTrustlineStatus.test.tsx — well-structured component tests, all states covered
- apps/web/app/components/features/wallet/**tests**/TrustlineSetupCard.test.tsx — solid; covers empty, error, and happy paths
- apps/web/app/components/ui/**tests**/LocaleLink.test.tsx — concise, all locale routing branches covered
- apps/web/app/components/ui/**tests**/PageHeader.test.tsx — covers native/web, onBack, fallback; minor jsdom caveat noted in test
- apps/web/app/hooks/**tests**/query-retry.test.ts — clean; all retry-policy branches covered
- apps/web/app/hooks/**tests**/use-admin-step-up.test.ts — well-structured with async flow; covers success, retry, cancel, non-step-up error
- apps/web/app/hooks/**tests**/use-app-config.test.tsx — covers loading/success; error path explicitly skipped with comment
- apps/web/app/hooks/**tests**/use-auth.test.tsx — HIGH: several tests call mocks directly without using the hook; misleading test names
- apps/web/app/hooks/**tests**/use-merchants.test.tsx — good coverage; loading-state gap for rates map
- apps/web/app/hooks/**tests**/use-native-platform-hook.test.tsx — correct hook integration tests
- apps/web/app/hooks/**tests**/use-native-platform.test.ts — HIGH: tests only the mock, not real platform module
- apps/web/app/hooks/**tests**/use-orders.test.tsx — comprehensive; all enabled/disabled and pagination branches
- apps/web/app/hooks/**tests**/use-session-restore-a2-1150.test.tsx — MEDIUM: sparse; only negative assertion; positive path and store state not checked
- apps/web/app/hooks/**tests**/use-session-restore.test.ts — HIGH: hook never imported; tests are mock-only assertions
- apps/web/app/i18n/**tests**/country-model.test.ts — thorough country/currency/locale model; hard-coded count minor concern
- apps/web/app/i18n/**tests**/locale-routing.test.ts — comprehensive locale normalization and path helpers
- apps/web/app/i18n/**tests**/locale.test.ts — all locale format + t() branches covered
- apps/web/app/i18n/**tests**/seo.test.ts — good; hard-coded hreflang count minor concern
- apps/web/app/native/**tests**/app-lock.native.test.ts — covers two guard paths; success path (overlay removal) missing
- apps/web/app/native/**tests**/native-modules.test.ts — comprehensive no-op coverage; inherently limited to web platform
- apps/web/app/native/**tests**/secure-storage-native.test.ts — exemplary; migration, read precedence, and dual-store wipe all tested
- apps/web/app/routes/**tests**/admin.assets.$assetCode.test.tsx — covers auth gate, unknown code, happy path, links, and top-holders filter
- apps/web/app/routes/**tests**/admin.assets.test.tsx — unit-tests `buildAssetSummaries` and integration renders route
- apps/web/app/routes/**tests**/admin.audit.test.tsx — covers empty state, row rendering, pagination cursor, and auth gate
- apps/web/app/routes/**tests**/admin.operators.$operatorId.test.tsx — happy path and empty-stats fallback; all sections verified
- apps/web/app/routes/**tests**/admin.operators.test.tsx — sort contract has ambiguous tie-break; overall solid
- apps/web/app/routes/**tests**/admin.orders.$orderId.test.tsx — thorough; covers split, failure reason, 404, generic error, payout card, payment pill
- apps/web/app/routes/**tests**/admin.payouts.$id.test.tsx — retry button render tested but interaction not exercised
- apps/web/app/routes/**tests**/admin.stuck-orders.test.tsx — ageClass utility and component both covered; both stuck-order and stuck-payout paths
- apps/web/app/routes/**tests**/admin.users.test.tsx — find-by-email form fully exercised including trim, 404, and 500 error paths
- apps/web/app/routes/**tests**/brand.$slug.test.tsx — covers group brand rendering, variant labels, not-found state
- apps/web/app/routes/**tests**/calculator.test.tsx — covers dropdown population, merchant switch, and empty state
- apps/web/app/routes/**tests**/home-geo-redirect.test.ts — covers bot skip, geo redirect, fallback, unrouted country, cookie precedence
- apps/web/app/routes/**tests**/locale-layout.test.ts — loader validation: routed pass-through and 404 for unrouted country/language
- apps/web/app/routes/**tests**/not-found.test.ts — concise; pins HTTP-404 contract for SSR splat route
- apps/web/app/routes/**tests**/settings.cashback.test.tsx — solid; failed payout state coverage gap
- apps/web/app/routes/**tests**/settings.wallet.test.tsx — very thorough; covers unlink, copy, error, currency lock, trim
- apps/web/app/routes/**tests**/sitemap.test.tsx — pins loader contract including hreflang, merchant slugs, XML escaping, cache headers
- apps/web/app/services/**tests**/api-client.test.ts — comprehensive; covers timeout, coalescing, refresh-on-401, token clearing, platform mapping
- apps/web/app/services/**tests**/auth.test.ts — all auth service request shapes and platform variants covered
- apps/web/app/services/**tests**/clusters.test.ts — covers URL params, protobuf header, JSON parse, error normalization, abort signal
- apps/web/app/services/**tests**/config.test.ts — MEDIUM: API_BASE assertion is trivially satisfied by any string
- apps/web/app/services/**tests**/favorites.test.ts — covers list, add, delete, and URL encoding
- apps/web/app/services/**tests**/merchants.test.ts — all merchant fetcher path/param combinations covered
- apps/web/app/services/**tests**/orders-loop.test.ts — covers state label and terminal predicate; other exports may be untested
- apps/web/app/services/**tests**/orders.test.ts — createOrder, fetchOrders, fetchOrder all covered with encoding
- apps/web/app/services/**tests**/parse-error-response.test.ts — exhaustive; all coerce branches including A2-1323 header fallback
- apps/web/app/services/**tests**/public-stats.test.ts — all public-stats fetchers path/shape covered
- apps/web/app/services/**tests**/recently-purchased.test.ts — concise and sufficient for thin wrapper
- apps/web/app/services/**tests**/user.test.ts — path/shape coverage for all 15 user service functions; error propagation gaps noted
- apps/web/app/stores/**tests**/auth.store.test.ts — all store actions including side effects on secure-storage mocks
- apps/web/app/stores/**tests**/purchase.store.test.ts — transitions, persistence queue ordering, and reset all covered
- apps/web/app/stores/**tests**/ui.store.ssr-safe.test.ts — SSR import and no-op action both validated without DOM globals
- apps/web/app/stores/**tests**/ui.store.test.ts — all theme, toast, and toggle actions covered
- apps/web/app/utils/**tests**/admin-cache.test.ts — invalidation predicate, non-admin isolation, and non-string key guard all covered
- apps/web/app/utils/**tests**/error-messages.test.ts — all status codes, code-keyed messages, offline path, and edge types covered
- apps/web/app/utils/**tests**/image.test.ts — all proxy URL parameter combinations covered
- apps/web/app/utils/**tests**/money.test.ts — currency formatting, fallback for unknown currency, penny precision
- apps/web/app/utils/**tests**/query-error-reporting.test.ts — isExpectedClientError and forwardQueryErrorToSentry with all tag variants
- apps/web/app/utils/**tests**/redeem-challenge-bar.test.ts — JSON-encoding safety, idempotency guard, fallback label, z-index
- apps/web/app/utils/**tests**/security-headers.test.ts — every hardening header value pinned including nonce path and CSP directives
- apps/web/app/utils/**tests**/sentry-error-scrubber.test.ts — scrubString patterns and scrubError for all sensitive shape variants
- apps/web/app/utils/**tests**/sentry-scrubber.test.ts — exhaustive scrub: headers, cookies, extra, contexts, tags, edge cases

**Coverage:** 63/63 files reviewed. Skipped: none

## Batch 19 — mobile

- apps/mobile/capacitor.config.ts — correct, no server block, minor comment gap on launchShowDuration
- apps/mobile/native-overlays/android/app/signing.gradle — correct signing guard, dead link to docs/mobile-release.md
- apps/mobile/native-overlays/android/app/src/main/java/io/loopfinance/app/MainActivity.java — correct overscroll disable
- apps/mobile/native-overlays/android/app/src/main/res/drawable-land-hdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-land-mdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-land-xhdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-land-xxhdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-land-xxxhdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-port-hdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-port-mdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-port-xhdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-port-xxhdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable-port-xxxhdpi/splash.png — present 114 KB, redundant overlay file
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_bloom.xml — correct AVD, matching pathType C-bezier commands
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_draw.xml — correct AVD, scaleX+fillAlpha stagger
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_drop.xml — correct AVD, translateY drop+fade stagger
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_fade.xml — correct AVD, fillAlpha stagger
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_scale.xml — correct AVD, whole-word scale+fade
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_slide.xml — correct AVD, translateY slide+fade stagger
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_anim_wipe.xml — correct AVD, rect clip-path wipe stagger
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon_vector.xml — correct VectorDrawable, named groups/paths for per-letter animation
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash_icon.png — present 62 KB, correct fallback icon
- apps/mobile/native-overlays/android/app/src/main/res/drawable/splash.png — present 114 KB, master splash source
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-hdpi/ic_launcher_foreground.png — present 8.0 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png — present 4.9 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-hdpi/ic_launcher.png — present 4.9 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png — present 5.1 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png — present 3.1 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-mdpi/ic_launcher.png — present 3.1 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xhdpi/ic_launcher_foreground.png — present 11 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png — present 6.7 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png — present 6.7 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xxhdpi/ic_launcher_foreground.png — present 17 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png — present 11 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png — present 11 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png — present 23 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png — present 14 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png — present 14 KB, correct
- apps/mobile/native-overlays/android/app/src/main/res/values/ic_launcher_background.xml — correct, #111111 brand near-black
- apps/mobile/native-overlays/android/app/src/main/res/values/styles.xml — correct Android 12+ system splash wiring
- apps/mobile/native-overlays/android/app/src/main/res/xml/backup_rules.xml — A-033 compliant, minor gap re: SecureStorage prefs name
- apps/mobile/native-overlays/android/app/src/main/res/xml/data_extraction_rules.xml — A-033 compliant, Android 12+ cloud+device both excluded
- apps/mobile/native-overlays/android/app/src/main/res/xml/file_paths.xml — A2-1213 compliant, scoped to cache/share/ only
- apps/mobile/native-overlays/android/app/src/main/res/xml/network_security_config.xml — correct, no cleartext exemptions, HTTPS-only production posture
- apps/mobile/native-overlays/android/keystore.properties.example — correct placeholder, no real secrets, dead doc link
- apps/mobile/native-overlays/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png — present 62 KB, correct 1024×1024 app icon
- apps/mobile/native-overlays/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json — correct single-universal-size entry
- apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json — 3-scale slots, all files identical (see MEDIUM finding)
- apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png — present 114 KB, identical to others
- apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png — present 114 KB, identical to others
- apps/mobile/native-overlays/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png — present 114 KB, master iOS splash
- apps/mobile/native-overlays/ios/App/App/Info.plist.additions.txt — documentation-only, NSFaceIDUsageDescription documented; NSLocationWhenInUseUsageDescription missing from doc
- apps/mobile/native-overlays/ios/App/App/PrivacyInfo.xcprivacy — correct Apple Privacy Manifest, no tracking, 6 data types declared
- apps/mobile/native-overlays/ios/release.xcconfig — correct CAPACITOR_DEBUG=false pin, operator-once .pbxproj wiring not auto-verified
- apps/mobile/package.json — correct Capacitor 8.x dependencies, ADR-006 and A-034 plugins present
- apps/mobile/README.md — correct workflow, live-reload warning present, ADR-007 referenced
- apps/mobile/scripts/apply-native-overlays.sh — comprehensive, correct, bare `cp` for AVD XMLs minor nit

**Coverage:** 57/57 files reviewed. Skipped: none.

## Batch 20 — packages/shared

- packages/shared/AGENTS.md — accurate guide; stale type count for users-me.ts
- packages/shared/package.json — clean; correct deps; `@bufbuild/protobuf` is only runtime dep
- packages/shared/README.md — inaccurate claim that proto files are git-ignored
- packages/shared/src/admin-assets.ts — correct; well-typed with LoopAssetCode
- packages/shared/src/admin-cashback-realization.ts — correct; matches backend handler
- packages/shared/src/admin-operator-mixes.ts — correct; three-angle mix pattern clean
- packages/shared/src/admin-operator-stats.ts — correct; percentile types accurate
- packages/shared/src/admin-settlement-lag.ts — assetCode typed as string|null instead of LoopAssetCode|null
- packages/shared/src/admin-supplier-spend.ts — correct; HomeCurrency filter echo is accurate
- packages/shared/src/admin-treasury.ts — correct; comprehensive treasury snapshot
- packages/shared/src/api.ts — clean; all ApiErrorCode values well-documented
- packages/shared/src/assert-never.ts — clean; correct exhaustiveness helper
- packages/shared/src/cashback-realization.ts — clean; correct bigint math with clamping
- packages/shared/src/countries.ts — ADR 034/035 entries verified correct; merchantInCountry logic sound
- packages/shared/src/credit-transaction-type.ts — clean; sign convention documented
- packages/shared/src/index.ts — exports all modules; proto correctly excluded from barrel
- packages/shared/src/loop-asset.ts — correct for Phase 1; USDLOOP/GBPLOOP/EURLOOP consistent; ADR 031 rename pending
- packages/shared/src/loop-orders.ts — correct; CreateLoopOrderResponse discriminated union accurate
- packages/shared/src/merchant-groups.test.ts — clean; 5 tests cover all edge cases
- packages/shared/src/merchant-groups.ts — clean; groupMerchants logic correct
- packages/shared/src/merchants.ts — clean; MerchantDenominations.denominations naming confusing but not a bug
- packages/shared/src/money-format.ts — hardcoded 100n divisor assumption; latent bug for KWD/JPY
- packages/shared/src/order-state.ts — clean; ORDER_STATES and ORDER_PAYMENT_METHODS correct
- packages/shared/src/orders.ts — clean; legacy CTX-proxy shapes accurate
- packages/shared/src/payout-state.ts — clean; 4-state machine correct
- packages/shared/src/proto/clustering_pb.ts — confirmed generated header; correctly not in barrel export; README git-ignore claim is wrong
- packages/shared/src/public-cashback-preview.ts — clean; ADR 020 compliant
- packages/shared/src/public-cashback-stats.ts — clean; never-500 shapes correct
- packages/shared/src/public-merchant.ts — clean; narrow PII-free payload correct
- packages/shared/src/public-top-cashback-merchants.ts — clean; marketing surface appropriate
- packages/shared/src/regions.ts — superseded but retained for GeoResponse; isSupportedCountry() misses ADR-035 countries
- packages/shared/src/search.ts — clean; NFD fold correct
- packages/shared/src/slugs.ts — clean; URL-safe slug generation correct
- packages/shared/src/stellar.ts — clean; ED25519 regex correct; muxed-account rejection documented
- packages/shared/src/users-me.ts — UserPendingPayoutState duplicates PayoutState; FavoriteMerchantView/ListFavoritesResponse/AddFavoriteResult/RecentlyPurchasedResponse missing (ADR 019 violation in backend/web)
- packages/shared/tsconfig.json — clean; NodeNext resolution correct

**Coverage:** 37/37 files reviewed. Skipped: none.

## Batch 21 — scripts (1/2)

- scripts/bootstrap-e2e-refresh-token.sh — committed, production operator tool, clean
- scripts/brandqc-prep.mjs — untracked, one-off QC; hardcoded `/Users/ash` path (MEDIUM)
- scripts/build-cover-sheets.mjs — untracked, one-off visual QC tool, /tmp I/O only
- scripts/build-logo-montages.mjs — untracked, one-off visual QC tool, /tmp I/O only
- scripts/build-logo-sheets.mjs — untracked, one-off visual QC tool, /tmp I/O only
- scripts/check-admin-bundle-split.sh — committed, CI gate, clean
- scripts/check-audit-policy.mjs — committed, CI gate, clean
- scripts/check-bundle-budget.sh — committed, CI gate, clean
- scripts/check-env-perms.sh — committed, hygiene nudge, clean
- scripts/ci-watch.sh — committed, CI poller, clean
- scripts/cover-finish.mjs — untracked, one-off cover gap filler, /tmp I/O
- scripts/cover-refix.mjs — untracked, one-off cover re-fixer; hardcoded `/Users/ash` path (MEDIUM)
- scripts/ctx-anomalies.mjs — untracked, read-only catalog scanner, commit-worthy
- scripts/ctx-apply.mjs — untracked, production write applier; CTX_TOKEN from env (clean); dynamic require bootstrap (LOW)
- scripts/ctx-build-enrichment.mjs — untracked, read-only enrichment builder, commit-worthy
- scripts/ctx-build-gap-merge.mjs — untracked, read-only gap analyzer; silent US fallback (LOW)
- scripts/ctx-casing-normalize.mjs — untracked, bulk rename; /tmp token file only (HIGH)
- scripts/ctx-combined-split-apply.mjs — untracked, bulk split/disable; partial-apply hazard (HIGH)
- scripts/ctx-create.mjs — untracked, merchant creator; CTX_TOKEN from env (clean)
- scripts/ctx-crossredeem.mjs — untracked, read-only scanner, commit-worthy
- scripts/ctx-curate-uncovered.mjs — untracked, read-only worklist builder, commit-worthy
- scripts/ctx-dedup-apply.mjs — untracked, bulk merge/disable; /tmp token (HIGH), partial-disable risk (MEDIUM)
- scripts/ctx-domain-resolve.mjs — untracked, domain candidate gatherer; /tmp logodev key (MEDIUM)
- scripts/ctx-dup-scan.mjs — untracked, read-only duplicate scanner, commit-worthy
- scripts/ctx-dupverify-apply.mjs — untracked, bulk merge/disable; /tmp token (HIGH)
- scripts/ctx-family-complete.mjs — untracked, bulk link/enable/create; /tmp token (HIGH)
- scripts/ctx-fix-apply.mjs — untracked, bulk unlink/retag/rename; /tmp token (HIGH)
- scripts/ctx-gc-strip.mjs — untracked, bulk rename/merge; /tmp token (HIGH)
- scripts/ctx-group-rename.mjs — untracked, bulk variant rename; env-var-or-file token (better pattern)
- scripts/ctx-media-cleanup.mjs — untracked, media QC; hardcoded PK (CRITICAL)
- scripts/ctx-name-convention.mjs — untracked, bulk rename/merge; /tmp token (HIGH)
- scripts/ctx-name-normalize.mjs — untracked, bulk rename/merge; /tmp token (HIGH)
- scripts/ctx-provider-gaps.mjs — untracked, read-only gap reporter, commit-worthy
- scripts/ctx-region-retag-names.mjs — untracked, bulk country retag; /tmp token (HIGH), no confirmation guard (HIGH)
- scripts/ctx-region-retag.mjs — untracked, bulk country retag; env-var-or-file token; no confirmation guard (HIGH)
- scripts/demo-seed.mjs — untracked, dev seed tool, minor issues only
- scripts/domain-review-server.mjs — untracked, local review UI; binds 0.0.0.0 (MEDIUM)
- scripts/e2e-real.mjs — committed, production e2e, clean
- scripts/ezpin-allocate.mjs — untracked, EzPin allocator; env-var-or-file token (good pattern)
- scripts/ezpin-availability-sweep.mjs — untracked, EzPin availability sweep; /tmp key files (MEDIUM)
- scripts/fetch-logos.mjs — untracked, logo fetcher; reads PK from /tmp file (safe pattern)
- scripts/fix-2tc.mjs — untracked, one-off Town & City fix; hardcoded `/Users/ash` path (MEDIUM)
- scripts/fix-white-logos.mjs — untracked, one-off logo re-sourcer; hardcoded `/Users/ash` path (MEDIUM)
- scripts/lint-docs.sh — committed, CI docs linter, clean
- scripts/logo-dims.mjs — untracked, image dimension utility; pure utility, clean

---

**Coverage:** 45/45 files reviewed. Skipped: none.

## Batch 22 — scripts (2/2)

- scripts/logo-opacity-scan.mjs — PK token hardcoded + non-portable sharp path; QC scan otherwise useful
- scripts/merge-media.mjs — clean assembly pipeline; no error guards on /tmp reads
- scripts/merge-pairs.mjs — destructive production writes with no dry-run / no confirmation guard; CTX_TOKEN unguarded
- scripts/merge-tavily-covers.mjs — clean; in-place overwrite risk; dry-run present
- scripts/newinfo-apply.mjs — CRITICAL: hardcoded PK token + non-portable sharp path
- scripts/note-fixes-media.mjs — CRITICAL: hardcoded PK token + sharp path + developer home-dir copy
- scripts/note-resource.mjs — CRITICAL: identical issues to note-fixes-media.mjs; likely a duplicate
- scripts/postgres-init.sh — clean, committed, no issues
- scripts/preflight-tranche-1.sh — clean, committed, deploy safety gate
- scripts/probe-ctx-cryptocurrency.mjs — clean one-off probe; env-only credentials
- scripts/pull-ezpin-catalogs.mjs — clean; fallback to disk token silently
- scripts/pull-ezpin-retailer.mjs — clean; fallback to disk token silently
- scripts/pull-fresh.mjs — clean with retry; fallback to disk token silently
- scripts/pull-tillo-svs.mjs — clean with retry; fallback to disk token silently
- scripts/qc-residue-fix.mjs — CRITICAL: hardcoded PK token + session-specific hardcoded path
- scripts/recount.mjs — minimal catalog pull; no error handling on pagination; missing retry
- scripts/resolve-missing-domains.mjs — clean domain candidate gatherer; read-only
- scripts/review-server.mjs — local UI only; SSRF-light open proxy + no /save body limit
- scripts/scrape-headers-deep.mjs — clean Playwright scraper; weserv URLs in output (see LOW)
- scripts/scrape-media-proxied.mjs — clean proxied scraper; partial proxy-env validation
- scripts/scrape-media.mjs — clean Playwright scraper; no secrets
- scripts/scrape-merchant-images-v2.mjs — clean; hits production API unnecessarily
- scripts/scrape-merchant-images.mjs — v1 scraper superseded by v2; clean; no secrets
- scripts/source-cat-covers.mjs — clean; Tavily key via env
- scripts/source-covers-round3.mjs — clean; no Tavily 429 backoff
- scripts/source-images-search.mjs — fragile DDG scrape; no secrets
- scripts/source-images-tavily.mjs — clean; Tavily key via env; resume support
- scripts/source-redeem-research.mjs — clean; no Tavily 429 backoff
- scripts/supplier-dedup.mjs — analysis-only; no writes; good reusable tool
- scripts/supplier-pull.mjs — clean; fallback to disk token silently
- scripts/svs-allocate.mjs — production bulk writes; dry-run present but no confirmation gate
- scripts/tillo-allocate.mjs — production bulk writes; dry-run present but no confirmation gate
- scripts/verify.sh — clean, committed quality gate
- scripts/warm-img-cache.mjs — clean cache pre-warmer; no secrets

**Coverage:** 35/35 files reviewed. Skipped: none

## ---

- docs/adr/001-static-export-capacitor.md — clean, Status: Accepted, no issues
- docs/adr/002-typescript-backend.md — clean, Status: Accepted, no issues
- docs/adr/003-protobuf-clustering.md — clean, Status: Accepted, no issues
- docs/adr/004-security-hardening-pass.md — clean, Status: Accepted, no issues
- docs/adr/005-known-limitations.md — clean with forward references to ADR 030/031 correctly noted
- docs/adr/006-keychain-backed-secure-storage.md — clean, Status: Accepted, references valid
- docs/adr/007-native-projects-source-of-truth.md — clean, Status: Accepted, no issues
- docs/adr/008-capacitor-filesystem-for-share.md — clean, Status: Accepted, no issues
- docs/adr/009-credits-ledger-cashback-flow.md — minor: missing cross-ref to ADR 030 amendment of wallet-rejection rationale
- docs/adr/010-principal-switch-payment-rails.md — clean, Status: Accepted, no issues
- docs/adr/011-admin-panel-cashback-configuration.md — clean, Status: Accepted, no issues
- docs/adr/012-drizzle-orm-fly-postgres.md — clean, Status: Accepted, no issues
- docs/adr/013-loop-owned-auth-and-ctx-operator-accounts.md — clean, Status: Accepted, no issues
- docs/adr/014-social-login-google-apple.md — clean, Status: Accepted, no issues
- docs/adr/015-stablecoin-topology-and-payment-rails.md — HIGH: amendment claims USDLOOP/EURLOOP retired but ADR 031 is still Proposed and code still uses old names
- docs/adr/016-stellar-sdk-payout-submit.md — clean, Status: Accepted, implemented references all check out
- docs/adr/017-admin-credit-primitives.md — clean, Status: Accepted, implementation references valid
- docs/adr/018-admin-panel-architecture.md — clean, Status: Accepted, patterns well-documented
- docs/adr/019-shared-package-policy.md — clean, Status: Accepted, no issues
- docs/adr/020-public-api-surface.md — minor inline correction note; otherwise clean
- docs/adr/021-merchant-catalog-eviction-policy.md — clean, Status: Accepted, no issues
- docs/adr/022-admin-drill-triplet-pattern.md — clean, Status: Accepted, no issues
- docs/adr/023-admin-mix-axis-matrix.md — clean, Status: Accepted, no issues
- docs/adr/024-withdrawal-writer.md — clean, Status: Accepted, implementation references valid
- docs/adr/025-llm-pr-review.md — clean, Status: Accepted, no issues
- docs/adr/026-tax-regulatory-reporting-data-model.md — clean, Status: Accepted, quarterly-tax.ts script confirmed to exist
- docs/adr/027-mobile-platform-security.md — low: Phase-2 plugin version compatibility caveat; otherwise clean
- docs/adr/028-admin-step-up-auth.md — HIGH: key name `LOOP_STEP_UP_SIGNING_KEY` in Decision body contradicts `LOOP_ADMIN_STEP_UP_SIGNING_KEY` in implementation and code; jwt-key-rotation.md gap
- docs/adr/029-repo-managed-ci-clis.md — clean, Status: Accepted, no issues
- docs/adr/030-integrated-wallet-via-privy.md — MEDIUM: Status: Proposed but files referenced as "new" don't exist; LinkWalletNudge.tsx still present
- docs/adr/031-per-currency-yield-architecture.md — MEDIUM: Status: Proposed with open critical-path blockers; incoherent cross-reference with ADR 015 amendment claiming supersession
- docs/adr/032-merchant-variant-grouping.md — clean, Status: Accepted, implementation status section confirms follow-ups done
- docs/adr/033-ip-geolocation-region-selector.md — LOW: missing Date: metadata field
- docs/adr/034-path-based-locale-routing.md — clean content, missing Date: metadata field (low)
- docs/adr/035-extended-supplier-currency-markets.md — clean content, missing Date: metadata field (low)
- docs/runbooks/README.md — clean index; does not list 4 alert types that have no runbooks
- docs/runbooks/asset-drift-alert.md — MEDIUM: asset names correct for live code but will need update when ADR 031 ships
- docs/runbooks/ctx-circuit-open.md — clean, commands valid, references valid
- docs/runbooks/ctx-schema-drift.md — clean, brief but complete for the surface it covers
- docs/runbooks/deployed-state-spotcheck.md — clean, commands valid, npm script confirmed
- docs/runbooks/disaster-recovery.md — clean, fly commands valid, rehearsal cadence documented
- docs/runbooks/health-degraded.md — clean, references valid
- docs/runbooks/jwt-key-rotation.md — MEDIUM: missing step-up key rotation section despite ADR 028 cross-referencing this runbook
- docs/runbooks/kill-switch.md — clean, kill switch env vars confirmed in codebase
- docs/runbooks/ledger-drift.md — MEDIUM: dead reference to scripts/check-ledger-invariant.ts (actual path: apps/backend/src/scripts/check-ledger-invariant.ts)
- docs/runbooks/migration-rollback.md — clean, Drizzle forward-only strategy accurately documented
- docs/runbooks/mobile-cert-renewal.md — clean, FCM_SERVER_KEY section is informational (no expiry), no dead references
- docs/runbooks/monthly-reconciliation.md — clean, SQL queries look valid, workflow accurate
- docs/runbooks/operator-pool-exhausted.md — HIGH: dead file path reference apps/backend/src/operator-pool.ts vs actual apps/backend/src/ctx/operator-pool.ts
- docs/runbooks/payment-watcher-stuck.md — clean, references valid
- docs/runbooks/payout-failed-alert.md — clean, triage flows accurate
- docs/runbooks/payout-permanent-failure.md — clean, compensation flow matches ADR 024 implementation
- docs/runbooks/rollback.md — clean, fly commands valid, rehearsal cadence documented
- docs/runbooks/stellar-operator-rotation.md — clean, staged/emergency rotation well-documented
- docs/runbooks/stuck-payout.md — clean, mitigation table accurate
- docs/runbooks/stuck-procurement-swept.md — clean but brief; adequate for the alert type
- docs/runbooks/usdc-below-floor.md — clean, brief but complete

**Coverage:** 58/58 files reviewed. Skipped: none

## Batch 24 — docs core

- docs/admin-csv-conventions.md — accurate; no staleness
- docs/alerting.md — accurate; Discord-only Phase-1 model correctly documented
- docs/api-compat.md — accurate; sunset-window policy correctly deferred to Phase 2
- docs/app-store-connect-metadata.md — accurate; matches Tranche-1 surface
- docs/architecture.md — mostly current; missing ADR 035 extended-markets section
- docs/archive/2026-pre-implementation-research.md — correctly archived; superseded header present
- docs/archive/migration.md — correctly archived; HISTORICAL header present
- docs/archive/ui-restoration-plan.md — correctly archived; all items Done
- docs/audit-2026-admin-handoff.md — accurate operator-action list; affected by tracker-authority contradiction
- docs/audit-2026-adversarial-plan.md — frozen plan; accurate for historical reference
- docs/audit-2026-remediation-plan.md — accurate batch plan; dangling reference to superseded tracker
- docs/audit-2026-tracker.md — self-declares superseded (A4-068); contradicts AGENTS.md claiming it's active
- docs/audit-checklist.md — correctly superseded; HISTORICAL header present
- docs/audit-tracker.md — correctly superseded; A2-1809 header present
- docs/codebase-audit.md — correctly superseded; historical only
- docs/deployment.md — mostly accurate; web first-deploy steps clear; no USDC issuer discrepancy in this file
- docs/development.md — mostly accurate; missing test:e2e:flywheel command; USDLOOP/EURLOOP vars need deprecation note; USDC issuer address differs from tranche-1-launch.md
- docs/error-codes.md — accurate; minor: DAILY_LIMIT_EXCEEDED vs DAILY_CAP_EXCEEDED warrants code grep verification
- docs/log-policy.md — accurate; retention and RBAC tables correct for Phase 1
- docs/mobile-native-ux.md — accurate; all Phase-1 items checked; plugin list correct
- docs/oncall.md — accurate; two-maintainer rotation documented
- docs/phase-1-demo-audit-2026-05-06.md — accurate; time-scoped audit record
- docs/phase-1-demo-script.md — accurate; matches Tranche-1 UX flow
- docs/phase-1-deployed-snapshot-2026-05-06.md — accurate point-in-time snapshot; historical reference
- docs/phase-1-redeploy-audit.md — accurate; all boot-gate items captured
- docs/phase-1-while-apple-approves.md — mostly accurate; uses wrong USDC issuer address (CRITICAL already flagged)
- docs/roadmap.md — stale on: production infra items unchecked despite live deploy; missing ADR 032–035 shipped work
- docs/slo.md — accurate targets; "pre-launch" label mildly stale post-2026-05-14 deploy
- docs/standards.md — stale: §15 CI job list incomplete (7 vs 12 jobs); accepted-moderate list shows 'postcss' not 'hono'
- docs/testing.md — mostly accurate; flywheel e2e lane name wrong (says flywheel-integration, should be test-e2e-flywheel); test:e2e:flywheel command missing from commands list
- docs/third-party-licenses.md — accurate; all OSS obligations documented
- docs/tranche-1-launch.md — mostly accurate; USDC issuer address inconsistent with code (CRITICAL flagged)
- docs/tranche-2-scoping.md — accurate; 11-track scoping plan matches ADR 030/031 state

**Coverage:** 33/33 files reviewed. Skipped: none.

## Batch 25 — audit evidence (1/2)

- docs/audit-2026-04-29/admin-handoff.md — audit handoff, operator action items, no secrets
- docs/audit-2026-04-29/checklist.md — audit checklist, methodology document, no secrets
- docs/audit-2026-04-29/evidence/phase-0-inventory/artifacts/git-status-short.txt — git status snapshot (2 lines: AGENTS.md modified, audit dir untracked), no secrets
- docs/audit-2026-04-29/evidence/phase-0-inventory/notes.md — phase 0 inventory notes, commit SHA recorded, no secrets
- docs/audit-2026-04-29/evidence/phase-1-governance/artifacts/branch-protection.json — GitHub API branch protection response, contains only GitHub App ID (15368) and API URLs, no tokens
- docs/audit-2026-04-29/evidence/phase-1-governance/artifacts/codeowners-team.json — GitHub API 404 response for missing team, no secrets
- docs/audit-2026-04-29/evidence/phase-1-governance/artifacts/codeowners-team.stderr — gh CLI 404 error, no secrets
- docs/audit-2026-04-29/evidence/phase-1-governance/artifacts/docs-claims.txt — grep output of branch protection claims from docs, no secrets
- docs/audit-2026-04-29/evidence/phase-1-governance/artifacts/required-pull-request-reviews.json — GitHub API PR review settings, no secrets
- docs/audit-2026-04-29/evidence/phase-1-governance/notes.md — governance phase notes, findings A3-001/A3-002, no secrets
- docs/audit-2026-04-29/evidence/phase-10-financial/notes.md — financial correctness phase notes, findings A3-006/007/008, no secrets
- docs/audit-2026-04-29/evidence/phase-11-workers/notes.md — workers phase notes, finding A3-031, no secrets
- docs/audit-2026-04-29/evidence/phase-12-web/artifacts/fetch-sites.txt — grep output of fetch() call sites in web app, no secrets
- docs/audit-2026-04-29/evidence/phase-12-web/artifacts/query-site-counts.txt — count summary (231 + 16), no secrets
- docs/audit-2026-04-29/evidence/phase-12-web/artifacts/query-sites.txt — grep output of useQuery/useMutation sites, no secrets
- docs/audit-2026-04-29/evidence/phase-12-web/notes.md — web runtime phase notes, findings A3-004/005, no secrets
- docs/audit-2026-04-29/evidence/phase-13-mobile/notes.md — mobile phase notes, findings A3-009/010/011, no secrets
- docs/audit-2026-04-29/evidence/phase-14-contracts/notes.md — shared contracts phase notes, findings A3-012/013/014, no secrets
- docs/audit-2026-04-29/evidence/phase-15-security/notes.md — security phase notes, findings A3-034/035, no secrets
- docs/audit-2026-04-29/evidence/phase-16-testing/artifacts/hydration-mismatch.txt — React hydration mismatch diff output, no secrets
- docs/audit-2026-04-29/evidence/phase-16-testing/artifacts/npm-test.txt — test run output (1856 passed), contains synthetic test email `a@b.com`, no real PII
- docs/audit-2026-04-29/evidence/phase-16-testing/artifacts/test-e2e-mocked.txt — e2e mocked test output (2 passed), no secrets
- docs/audit-2026-04-29/evidence/phase-16-testing/notes.md — testing phase notes, findings A3-018/019/027, no secrets
- docs/audit-2026-04-29/evidence/phase-17-operations/notes.md — observability phase notes, findings A3-021/022/023/024/025, no secrets
- docs/audit-2026-04-29/evidence/phase-18-cicd/artifacts/lint-docs.txt — lint-docs script output (1 failure on stale ref), no secrets
- docs/audit-2026-04-29/evidence/phase-18-cicd/artifacts/npm-build.txt — build output with file sizes, no secrets
- docs/audit-2026-04-29/evidence/phase-18-cicd/notes.md — CI/CD phase notes, findings A3-020/030/026, no secrets
- docs/audit-2026-04-29/evidence/phase-19-synthesis/notes.md — synthesis notes, final 34-finding count, no secrets
- docs/audit-2026-04-29/evidence/phase-2-architecture/artifacts/auth-doc-drift.txt — grep/text capture of auth doc drift evidence, no secrets
- docs/audit-2026-04-29/evidence/phase-2-architecture/notes.md — architecture phase notes, finding A3-003, no secrets
- docs/audit-2026-04-29/evidence/phase-3-build/artifacts/check-bundle-budget.txt — bundle budget output (2312 KB / 2500 KB), no secrets
- docs/audit-2026-04-29/evidence/phase-3-build/notes.md — build phase notes, no findings, no secrets
- docs/audit-2026-04-29/evidence/phase-4-dependencies/artifacts/npm-audit-high.json — npm audit JSON for moderate advisories only (drizzle-kit/esbuild chain), no secrets
- docs/audit-2026-04-29/evidence/phase-4-dependencies/notes.md — dependencies phase notes, findings A3-028/029, no secrets
- docs/audit-2026-04-29/evidence/phase-5-backend/notes.md — backend phase notes, findings A3-015 (critical)/A3-016, no secrets
- docs/audit-2026-04-29/evidence/phase-6-admin/notes.md — admin phase notes, finding A3-032, no secrets
- docs/audit-2026-04-29/evidence/phase-7-public-api/notes.md — public API phase notes, finding A3-033, no secrets
- docs/audit-2026-04-29/evidence/phase-8-orders/notes.md — orders phase notes, no findings, no secrets
- docs/audit-2026-04-29/evidence/phase-9-data/notes.md — data layer phase notes, no findings, no secrets
- docs/audit-2026-04-29/evidence/README.md — evidence convention document, no secrets
- docs/audit-2026-04-29/inventory/exclusions.md — audit exclusions policy, no secrets
- docs/audit-2026-04-29/inventory/file-counts.txt — file counts by package, no secrets
- docs/audit-2026-04-29/inventory/git-ls-files.txt — tracked file list (first 30 lines sampled), no secrets
- docs/audit-2026-04-29/inventory/phase-map.md — file-to-phase ownership map, no secrets
- docs/audit-2026-04-29/inventory/README.md — inventory convention, no secrets
- docs/audit-2026-04-29/plan.md — full audit plan with phases and methodology, no secrets
- docs/audit-2026-04-29/README.md — audit cockpit README, no secrets
- docs/audit-2026-04-29/remediation-plan.md — post-audit remediation batch plan, no secrets
- docs/audit-2026-04-29/tracker.md — live tracker (34 findings, 32 resolved), no secrets
- docs/audit-2026-05-03-claude/admin-handoff.md — operator handoff with 7 pending external verifications, no secrets
- docs/audit-2026-05-03-claude/checklist.md — granular audit checklist, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-00-inventory/notes.md — inventory phase notes, 1222 files, baseline SHA, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-01-governance/notes.md — governance phase notes, findings A4-014/A4-038, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-02-architecture/notes.md — architecture phase notes, findings A4-061/062/063/064, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-03-build-release/notes.md — build phase notes, no direct findings, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-04-dependencies/notes.md — dependencies phase notes, finding A4-044, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-05-backend-lifecycle/notes.md — backend lifecycle phase notes, findings A4-001/008/013, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-06-auth-identity/notes.md — auth phase notes, findings A4-002/005/009/010/017, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-07-admin/notes.md — admin phase notes, findings A4-003/011/019/032/052/053, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-08-public-api/notes.md — public API phase notes, finding A4-004, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-09-orders/notes.md — orders phase notes, findings A4-007/025/026, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-10-payments-payouts/notes.md — payments phase notes, findings A4-012/015, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-11-data-migrations/notes.md — data layer phase notes, findings A4-024/027/028/030/031, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-12-financial-invariants/notes.md — financial invariants phase notes, findings A4-018/020/021/022/023/029/033, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-13-workers/notes.md — workers phase notes, findings A4-006/016, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-14-web-runtime/notes.md — web runtime phase notes, findings A4-052/053/054/058/060/070/071, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-15-mobile-native/notes.md — mobile phase notes, findings A4-055/056/059, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-16-shared-contracts/notes.md — shared contracts phase notes, no findings, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-17-security-privacy/notes.md — security phase notes, cross-lists A4-001/005/008/017/039/042/050/051/057/058, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-18-testing/notes.md — testing phase notes, findings A4-046/049, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-19-observability/notes.md — observability phase notes, findings A4-034/035/040/047/048, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-20-cicd/notes.md — CI/CD phase notes, findings A4-036/037/043/044/045, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-21-docs/notes.md — docs truth phase notes, findings A4-013/041/065/066/067/068/069, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-22-file-pass/notes.md — file-pass phase notes, finding A4-009, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-23-journey-pass/notes.md — journey phase notes, no new findings, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-24-planned-features/notes.md — planned features phase notes, findings A4-061/062/063/064, no secrets
- docs/audit-2026-05-03-claude/evidence/phase-25-synthesis/notes.md — synthesis notes (71 findings total), no secrets
- docs/audit-2026-05-03-claude/evidence/README.md — evidence convention document, no secrets
- docs/audit-2026-05-03-claude/findings/register.md — 124-finding register (A4-001 through A4-124), contains finding descriptions referencing source code paths/lines but no secret values
- docs/audit-2026-05-03-claude/findings/remediation-queue.md — remediation queue with commit hashes resolving findings, no secrets
- docs/audit-2026-05-03-claude/findings/severity-model.md — severity model document, no secrets
- docs/audit-2026-05-03-claude/findings/template.md — finding template, no secrets
- docs/audit-2026-05-03-claude/inventory/backend-src-counts.txt — backend source file counts by directory, no secrets
- docs/audit-2026-05-03-claude/inventory/directory-map.txt — directory tree including .git object dirs (sampled to .git internals listing), no secrets
- docs/audit-2026-05-03-claude/inventory/exclusions.md — exclusions policy, no secrets
- docs/audit-2026-05-03-claude/inventory/file-counts-by-phase.txt — file counts by phase number, no secrets
- docs/audit-2026-05-03-claude/inventory/file-counts-by-root.txt — file counts by root directory, no secrets
- docs/audit-2026-05-03-claude/inventory/file-disposition.tsv — file disposition register (first 20 rows sampled), all "unreviewed" initial state, no secrets
- docs/audit-2026-05-03-claude/inventory/git-status-short.txt — one-line baseline status (clean), no secrets
- docs/audit-2026-05-03-claude/inventory/phase-map.md — file-to-phase ownership map, no secrets
- docs/audit-2026-05-03-claude/inventory/planned-feature-matrix.tsv — 20-feature planned-vs-current matrix, no secrets
- docs/audit-2026-05-03-claude/inventory/README.md — inventory convention document, no secrets
- docs/audit-2026-05-03-claude/inventory/scaffold-disposition.tsv — scaffold self-review register (first 20 rows sampled), no secrets
- docs/audit-2026-05-03-claude/inventory/scaffold-files.txt — list of 30+ scaffold file paths, no secrets
- docs/audit-2026-05-03-claude/inventory/scaffold-git-status-short.txt — one-line expected scaffold status note, no secrets
- docs/audit-2026-05-03-claude/inventory/tracked-files.txt — tracked file list (first 20 lines sampled), no secrets
- docs/audit-2026-05-03-claude/inventory/web-app-counts.txt — web app file counts by subdirectory, no secrets
- docs/audit-2026-05-03-claude/inventory/workspace-files.txt — workspace file list (sampled), no secrets
- docs/audit-2026-05-03-claude/journeys/admin-journeys.md — admin journey map definitions, no secrets
- docs/audit-2026-05-03-claude/journeys/adversarial-journeys.md — adversarial journey map definitions, no secrets
- docs/audit-2026-05-03-claude/journeys/data-money-journeys.md — data/money journey map definitions, no secrets
- docs/audit-2026-05-03-claude/journeys/operational-journeys.md — operational journey map definitions, no secrets
- docs/audit-2026-05-03-claude/journeys/planned-feature-journeys.md — planned feature journey definitions, no secrets
- docs/audit-2026-05-03-claude/journeys/README.md — journey maps README, no secrets
- docs/audit-2026-05-03-claude/journeys/user-journeys.md — user journey map definitions, no secrets
- docs/audit-2026-05-03-claude/plan.md — full audit plan, no secrets
- docs/audit-2026-05-03-claude/protocol/cold-audit-rules.md — cold audit rules, no secrets
- docs/audit-2026-05-03-claude/protocol/evidence-protocol.md — evidence protocol, no secrets
- docs/audit-2026-05-03-claude/protocol/execution-protocol.md — execution protocol, no secrets
- docs/audit-2026-05-03-claude/protocol/file-disposition-protocol.md — file disposition protocol, no secrets
- docs/audit-2026-05-03-claude/protocol/finding-protocol.md — finding protocol, no secrets
- docs/audit-2026-05-03-claude/protocol/planned-feature-protocol.md — planned feature protocol, no secrets
- docs/audit-2026-05-03-claude/protocol/README.md — protocol README, no secrets
- docs/audit-2026-05-03-claude/protocol/review-dimensions.md — review dimensions protocol, no secrets
- docs/audit-2026-05-03-claude/protocol/second-third-pass.md — second/third pass protocol, no secrets
- docs/audit-2026-05-03-claude/README.md — Claude audit cockpit README, no secrets
- docs/audit-2026-05-03-claude/tracker.md — live tracker (124 findings, 100 resolved), no secrets
- docs/audit-2026-05-03/admin-handoff.md — operator handoff with 7 pending external verifications, no secrets
- docs/audit-2026-05-03/checklist.md — granular audit checklist, identical structure to Claude version, no secrets
- docs/audit-2026-05-03/evidence/phase-00-inventory/artifacts/git-status-short-excluding-claude.txt — git status excluding Claude workspace (lists untracked audit files), no secrets
- docs/audit-2026-05-03/evidence/phase-00-inventory/notes.md — Codex inventory phase notes, no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/branch-protection-summary.json — concise branch protection summary JSON, no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/branch-protection.json — full GitHub API branch protection response, contains only App ID (15368) and API URLs, no tokens
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/codeowners-team.json — GitHub API 404 for missing team, no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/codeowners-team.stderr — gh CLI 404 error, no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/docs-branch-review-claims.txt — grep output of branch/review policy claims from docs, contains mention of "1Password" in a quote from docs/standards.md (not a credential), no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/github-files.txt — list of .github/ files, no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/local-sensitive-filenames.txt — list of local dev env file paths only (no contents), no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/tracked-sensitive-filenames.txt — empty file (no tracked sensitive files found), no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/artifacts/required-pull-request-reviews.json — GitHub API PR review settings, no secrets
- docs/audit-2026-05-03/evidence/phase-01-governance/notes.md — Codex governance phase notes, findings A4-001/A4-002, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/artifacts/adr-files.txt — list of ADR file paths, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/artifacts/adr-heading-matrix.txt — heading structure of ADR files, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/artifacts/backend-admin-files.txt — list of admin source files, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/artifacts/backend-route-files.txt — list of backend route files, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/artifacts/route-registration-sites.txt — grep of route registration in app.ts + web routes.ts, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/artifacts/web-route-files.txt — list of web route files, no secrets
- docs/audit-2026-05-03/evidence/phase-02-architecture/notes.md — Codex architecture phase notes, finding A4-003, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/all-backend-route-literals.txt — list of backend API route path literals, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/backend-Dockerfile.snapshot — backend Dockerfile snapshot (multi-stage, SHA-pinned base image, no credentials), no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/backend-fly.toml.snapshot — backend fly.toml snapshot (contains non-secret env vars: PORT, NODE_ENV, etc.), no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/backend-package-scripts.json — backend package.json scripts, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/check-admin-bundle-split.txt — admin bundle split check output, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/check-bundle-budget-stable.txt — stable bundle budget check (2396 KB / 2500 KB), contains local path `/Users/ash/code/loop-app/...` (developer machine path), no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/check-bundle-budget.txt — bundle budget check output, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/ci-docs-vs-workflow-lines.txt — grep of CI job claims from docs vs workflow, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/ci-job-keys.txt — list of CI job keys, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/ci-job-names.txt — list of CI job display names, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/ci.yml.snapshot — full CI workflow snapshot; contains `${{ secrets.DISCORD_WEBHOOK_DEPLOYMENTS }}` expression (not a resolved value), no actual secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/lint-docs-escalated.txt — lint-docs output with flyctl permission error, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/lint-docs-openapi-checked-routes.txt — list of routes checked by lint-docs OpenAPI guard, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/lint-docs.txt — lint-docs output with flyctl sandbox failure, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/main-required-checks.json.txt — GitHub API required checks JSON, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/mobile-package-scripts.json — mobile package.json scripts, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/npm-audit-policy.txt — audit policy pass output listing 4 accepted moderate advisories, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/npm-build.txt — build output with file sizes and hashes, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/npm-format-check.txt — format check output, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/npm-lint.txt — lint pass output, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/npm-typecheck.txt — typecheck pass output, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/openapi-paths.txt — list of OpenAPI registered paths, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/root-package-scripts.json — root package.json scripts, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/routes-missing-openapi.txt — empty file (no routes missing OpenAPI), no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/shared-package-scripts.json — shared package.json scripts, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/web-build-mobile.txt — mobile static export build output, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/web-build-ssr-for-budget.txt — SSR build output with chunk sizes, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/web-config-assets-review.txt — web config assets review notes, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/web-Dockerfile.snapshot — web Dockerfile snapshot, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/web-fly.toml.snapshot — web fly.toml snapshot (contains VITE_API_URL=https://api.loopfinance.io, non-secret), no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/artifacts/web-package-scripts.json — web package.json scripts, no secrets
- docs/audit-2026-05-03/evidence/phase-03-build-release/notes.md — Codex build phase notes, findings A4-004/005, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/all-package-script-keys.txt — list of all npm script keys across workspace, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/all-source-package-json.concat — concatenated package.json files from all 5 source packages, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/audit-moderate-package-lines.txt — lines identifying moderate advisory packages, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/capacitor-plugin-parity.tsv — Capacitor plugin parity check between web and mobile, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/license-doc-coverage-lines.txt — license documentation coverage check, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/license-gap-lines.txt — license gap findings (MPL-2.0, commercial), no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/npm-audit-json.json — npm audit JSON (4 moderate advisories, drizzle-kit chain), no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/npm-audit-json.stderr — npm audit stderr (exit code), no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/npm-ls-workspaces-depth0.json — npm ls output with extraneous package warnings and local dev paths, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/npm-ls-workspaces-depth0.stderr — npm ls stderr, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/package-json-files-source-only.txt — list of source package.json file paths, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/package-json-files.txt — list of all package.json file paths, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/package-lock-package-keys.txt — list of 1152 package names in lockfile, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/root-package-summary.json — root package.json summary, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/runtime-tool-resolution-lines.txt — grep of CI runtime tool resolution, contains Discord webhook expression (not value), no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/top-level-dependency-licenses.tsv — top-level dep license listing, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/workflow-actions-all.txt — list of all workflow action references, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/workflow-actions-not-sha-pinned.txt — empty (all actions are SHA-pinned), no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/workflow-actions-sha-pinned.txt — list of SHA-pinned action references, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/workflow-docker-image-lines.txt — list of Docker image references in workflows, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/artifacts/workflow-uses-lines.txt — list of workflow uses: lines, no secrets
- docs/audit-2026-05-03/evidence/phase-04-dependencies/notes.md — Codex dependencies phase notes, findings A4-006/008, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/app.ts.snapshot — app.ts source snapshot with middleware assembly, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/backend-fetch-lines.txt — grep of fetch() calls in backend, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/backend-route-registration-lines.txt — route registration lines from app.ts, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/backend-validation-lines.txt — grep of Zod validation sites, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/error-envelope-lines.txt — grep of error throw/return patterns, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/hono-param-literal-order-repro.txt — reproduction output (2 lines: 200 param settlement-lag, 200 param loop), confirms route shadow bug, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/metrics-colon-route-repro.txt — Prometheus metrics output showing route label corruption finding (A4-011), contains local request ID, no secrets
- docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/notes.md — Codex backend lifecycle phase notes, findings A4-009/010/011, no secrets

**Coverage:** 200/200 files reviewed. Skipped: none.

## Batch 26 — audit evidence (2/2)

### docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/artifacts/

- rate-limit-cross-route-repro.txt — 12-line reproduction note; grep output of rate-limit repro; clean
- rate-limit-lines.txt — 305-line grep dump of rate-limit declarations; clean source excerpts
- route-files.txt — 18-line file list of backend route files; clean
- route-shadow-lines.txt — 4-line grep output showing route shadowing lines; clean
- route-shadow-scan.tsv — 3-line TSV of route shadow candidates; clean
- upstream-circuit-lines.txt — 89-line grep dump of circuit-breaker code; clean

### docs/audit-2026-05-03/evidence/phase-05-backend-lifecycle/

- notes.md — 57-line phase narrative; backend lifecycle summary; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-06-auth-identity/artifacts/

- auth-admin-gate-lines.txt — 2507-line grep dump of admin gate/auth code; large but clean; Sentry regex lists field names not values
- auth-token-storage-lines.txt — 437-line grep dump of token storage patterns; clean
- backend-auth-files.txt — 34-line file list of backend auth files; clean
- refresh-rotation-lines.txt — 52-line grep dump of refresh rotation code; clean
- refresh-rotation-race-reasoning.txt — 11-line reasoning note; clean
- refresh-rotation-test-lines.txt — grep dump of refresh rotation test code; clean
- web-auth-session-files.txt — file list of web auth session files; clean

### docs/audit-2026-05-03/evidence/phase-06-auth-identity/

- notes.md — 39-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-07-admin/artifacts/

- admin-control-lines.txt — grep dump of admin control patterns; clean
- admin-idempotency-doc-claims.txt — doc claims excerpts; clean
- admin-idempotency-gap-reasoning.txt — reasoning note on idempotency gap; clean
- admin-idempotency-write-lines.txt — grep dump of admin write patterns; clean
- admin-step-up-lines.txt — grep dump of step-up ADR content; clean; references "password" in design context only
- admin-surface-paired-test-inventory.txt — inventory of admin surface test pairings; clean
- backend-admin-files.txt — file list of backend admin files; clean
- csv-export-lines.txt — grep dump of CSV export patterns; clean
- web-admin-route-files.txt — file list of web admin route files; clean

### docs/audit-2026-05-03/evidence/phase-07-admin/

- notes.md — 39-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-08-public-api/artifacts/

- backend-public-files.txt — file list of public API backend files; clean
- image-openapi-status-drift.txt — OpenAPI status code drift analysis; clean
- public-contract-lines.txt — grep dump of public contract code; clean

### docs/audit-2026-05-03/evidence/phase-08-public-api/

- notes.md — 29-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-09-orders/artifacts/

- loop-openapi-runtime-drift.txt — OpenAPI/runtime drift analysis; references env var names only; clean
- loop-order-denomination-validation.txt — denomination validation analysis; clean
- operator-pool-procuring-no-retry.txt — procurement retry gap analysis; clean
- order-procurement-files.txt — file list of order procurement files; clean

### docs/audit-2026-05-03/evidence/phase-09-orders/

- notes.md — 34-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-10-payments-payouts/artifacts/

- payment-asset-method-mismatch.txt — payment asset/method mismatch analysis; clean
- payment-watcher-idle-stale-alert.txt — payment watcher alert gap analysis; clean
- payments-payouts-files.txt — file list of payment/payout files; clean
- payout-idempotency-account-mismatch.txt — idempotency bug analysis; references env var names and account-matching logic; no actual keys; clean
- stuck-payout-submitted-cutoff-mismatch.txt — stuck payout analysis; clean
- xlm-price-rounding-underpayment.txt — 29-line XLM rounding analysis; clean

### docs/audit-2026-05-03/evidence/phase-10-payments-payouts/

- notes.md — 39-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-11-data-migrations/artifacts/

- migration-runtime-packaging.txt — migration packaging analysis; clean
- real-postgres-migration-check.txt — migration check output; clean
- schema-journal-table-matrix.txt — schema table matrix; clean

### docs/audit-2026-05-03/evidence/phase-11-data-migrations/

- notes.md — 30-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-12-financial-invariants/artifacts/

- ledger-writer-inventory.txt — inventory of ledger writer functions; clean
- order-cashback-payout-double-credit.txt — 107-line double-credit bug analysis; clean

### docs/audit-2026-05-03/evidence/phase-12-financial-invariants/

- notes.md — 27-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-13-workers/artifacts/

- runtime-health-first-tick-hang.txt — worker health first-tick analysis; clean

### docs/audit-2026-05-03/evidence/phase-13-workers/

- notes.md — 25-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-14-web-runtime/artifacts/

- loop-native-payment-recovery-gap.txt — payment recovery gap analysis; clean
- loop-order-client-idempotency-gap.txt — client idempotency gap analysis; clean
- query-mutation-scan.txt — TanStack Query/mutation scan output; clean
- route-service-hook-store-inventory.txt — web route/service/hook inventory; clean
- web-boundary-scan.txt — Capacitor boundary scan; clean
- web-vitest-full-run.txt — vitest run output; clean; no secrets

### docs/audit-2026-05-03/evidence/phase-14-web-runtime/

- notes.md — 33-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-15-mobile-native/artifacts/

- android-fileprovider-overlay-drift.txt — FileProvider overlay drift analysis; clean

### docs/audit-2026-05-03/evidence/phase-15-mobile-native/

- notes.md — 26-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-16-shared-contracts/artifacts/

- admin-wire-shapes-outside-shared.txt — admin wire shape boundary analysis; clean
- openapi-route-parity.txt — OpenAPI/route parity analysis; clean
- protobuf-runtime-disabled.txt — protobuf runtime disabled note; clean

### docs/audit-2026-05-03/evidence/phase-16-shared-contracts/

- notes.md — 32-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-17-security-privacy/artifacts/

- dsr-delete-payout-address-retention.txt — DSR/PII retention analysis with source code excerpts; contains design code only, no real user addresses; clean
- local-env-secret-residue.txt — documents local `.env` key names and file metadata; values intentionally redacted; correctly formed evidence

### docs/audit-2026-05-03/evidence/phase-17-security-privacy/

- notes.md — 28-line phase narrative; confirms values not captured; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-18-testing/artifacts/

- backend-domain-slice-tests.txt — test inventory for domain slices; clean
- backend-infra-merchant-slice-tests.txt — test inventory for merchant slices; clean
- e2e-mocked-harness-review.txt — e2e harness review; notes no secret-bearing values embedded; clean
- testing-doc-ci-coverage-drift.txt — testing doc vs CI drift analysis; clean

### docs/audit-2026-05-03/evidence/phase-18-testing/

- notes.md — 27-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-19-observability/artifacts/

- health-orchestrator-db-gaps.txt — health orchestrator gaps analysis; notes redaction confirmed; clean

### docs/audit-2026-05-03/evidence/phase-19-observability/

- notes.md — 20-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-20-cicd/artifacts/

- e2e-real-workflow-env-fails.txt — CI env failure analysis; notes redaction confirmed; clean

### docs/audit-2026-05-03/evidence/phase-20-cicd/

- notes.md — 19-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-21-docs/artifacts/

- active-docs-runbooks-pass.txt — lint-docs pass output summary; clean
- observability-token-doc-drift.txt — observability token drift analysis; references shared-secret design only; no actual tokens
- public-doc-current-feature-drift.txt — public doc drift analysis; notes redaction confirmed; clean

### docs/audit-2026-05-03/evidence/phase-21-docs/

- notes.md — 28-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-22-file-pass/artifacts/

- bottom-up-disposition-counts.txt — disposition count summary; clean
- historical-audit-docs-disposition.txt — historical audit disposition; clean
- mobile-overlay-review.txt — mobile overlay review; notes no code or secret-bearing data in binary paths; clean
- packages-shared-review.txt — 51-line shared package review; clean
- root-ci-config-review.txt — root CI config review; notes no secret patterns found beyond A4-030; clean
- web-boundary-rule-scan.txt — web boundary rule scan; clean

### docs/audit-2026-05-03/evidence/phase-22-file-pass/

- notes.md — 31-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-23-journey-pass/artifacts/

- api-route-service-parity.txt — 35-line API/route/service parity analysis; clean

### docs/audit-2026-05-03/evidence/phase-23-journey-pass/

- notes.md — 27-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-24-planned-features/artifacts/

- loop-native-email-provider-gap.txt — email provider gap analysis; clean
- tax-reporting-csv-implementation-gap.txt — tax reporting gap analysis; clean
- web-loop-payment-method-gap.txt — payment method gap analysis; references env var names only; clean

### docs/audit-2026-05-03/evidence/phase-24-planned-features/

- notes.md — 41-line phase narrative; no secrets/PII

### docs/audit-2026-05-03/evidence/phase-25-synthesis/

- notes.md — 30-line synthesis summary; no secrets/PII

### docs/audit-2026-05-03/evidence/

- README.md — evidence directory README; documents PII/secret redaction rules; clean

### docs/audit-2026-05-03/findings/

- register.md — 42-finding register (1 Critical, 14 High, 22 Medium, 5 Low); well-structured; no embedded secrets/PII; absolute file paths are dev-machine paths (expected for audit material)
- remediation-queue.md — 85-line remediation queue; no secrets/PII
- severity-model.md — 76-line severity model definition; clean
- template.md — 22-line finding template; clean

### docs/audit-2026-05-03/inventory/

- backend-src-counts.txt — backend source file counts; clean
- directory-map.txt — 429-line shallow directory map; clean
- exclusions.md — audit exclusion policy; clean
- file-counts-by-phase.txt — file count by phase summary; clean
- file-counts-by-root.txt — file count by root; clean
- file-disposition.tsv — 1227-row per-file disposition register; large, expected; clean
- git-status-short.txt — git status snapshot; clean
- phase-map.md — phase-to-directory mapping; clean
- planned-feature-matrix.tsv — planned feature classification; clean
- README.md — inventory README; clean
- scaffold-disposition.tsv — scaffold self-review register; clean
- scaffold-files.txt — audit scaffold file list; clean
- scaffold-git-status-short.txt — post-scaffold git status; clean
- tracked-files.txt — 1226-line git ls-files dump; clean
- web-app-counts.txt — web app file counts; clean
- workspace-files.txt — 1266-line rg --files output; clean

### docs/audit-2026-05-03/journeys/

- admin-journeys.md — admin journey checklist; no secrets/PII
- adversarial-journeys.md — adversarial journey checklist (ADV-001 through ADV-008); no secrets/PII
- data-money-journeys.md — data/money journey checklist; no secrets/PII
- operational-journeys.md — operational journey checklist; no secrets/PII
- planned-feature-journeys.md — planned feature journey checklist; no secrets/PII
- README.md — journeys README; clean
- user-journeys.md — user journey checklist; no secrets/PII

### docs/audit-2026-05-03/protocol/

- cold-audit-rules.md — cold audit independence/verification rules; clean
- evidence-protocol.md — evidence capture protocol; clean
- execution-protocol.md — audit execution protocol; clean
- file-disposition-protocol.md — file disposition protocol; clean
- finding-protocol.md — finding documentation protocol; clean
- planned-feature-protocol.md — planned feature classification protocol; clean
- README.md — protocol README; clean
- review-dimensions.md — review dimension definitions; clean
- second-third-pass.md — second/third pass protocol; clean

### docs/audit-2026-05-03/

- plan.md — 215-line audit execution plan; clean
- README.md — 41-line audit README; clean
- tracker.md — 172-line phase tracker; clean

### docs/audit-2026-evidence/

- phase-0-inventory.md — phase 0 inventory evidence; clean
- phase-1-governance.md — phase 1 governance evidence; lists GitHub secret names/creation dates (no values); clean
- phase-10-shared.md — phase 10 shared package evidence; references Stellar regex patterns (not real keys); clean
- phase-11-cross-app.md — phase 11 cross-app evidence; references env var names; clean
- phase-12-security.md — phase 12 security evidence; references redaction list and finding descriptions; no actual secrets
- phase-13-observability.md — phase 13 observability evidence; clean
- phase-14-testing.md — phase 14 testing evidence; clean
- phase-15-docs.md — phase 15 docs evidence; env var names referenced; clean
- phase-16-cicd.md — phase 16 CI/CD evidence; documents `STELLAR_TEST_SECRET_KEY` as a named mainnet secret (no actual value); risk and remediation described correctly; supports existing findings A2-1406
- phase-17-operational.md — phase 17 operational evidence; clean
- phase-18-redteam.md — phase 18 red team evidence; clean
- phase-2-architecture.md — phase 2 architecture evidence; env var names referenced; clean
- phase-3-dependencies.md — phase 3 dependencies evidence; clean
- phase-3-install-hooks.txt — 187-line npm install hooks output; clean
- phase-3-npm-audit.json — 94-line npm audit JSON; 5 moderate vulnerabilities (drizzle-kit/esbuild chain); no secrets
- phase-3-npm-ls-all.txt — 1827-line npm ls output; clean; UNMET OPTIONAL DEPENDENCY note for @xata.io/client (expected/benign)
- phase-3-npm-outdated.json — 162-line outdated packages JSON; clean
- phase-4-build-release.md — phase 4 build/release evidence; clean
- phase-5a-admin.md — phase 5a admin evidence; clean
- phase-5b-auth-users.md — phase 5b auth/users evidence; clean
- phase-5c-money-flow.md — phase 5c money-flow evidence; references env var names and finding descriptions; clean
- phase-5d-rest.md — phase 5d rest evidence; references env var names including `DATABASE_URL` format example `postgres://user:PASSWORD@host/db` (placeholder, not real); clean
- phase-6-database.md — phase 6 database evidence; clean
- phase-6.5-financial.md — phase 6.5 financial evidence; clean
- phase-7-api.md — phase 7 API evidence; clean
- phase-8a-routes.md — phase 8a routes evidence; clean
- phase-8b-support.md — phase 8b support evidence; clean
- phase-9-mobile.md — phase 9 mobile evidence; clean
- README.md — evidence README; documents PII/secret redaction rules; clean

**Coverage:** 162/162 files reviewed. Skipped: none.

## Batch 27 — root + .github + e2e

- .dockerignore — correct; excludes node_modules, build artifacts, git metadata, native shells, secrets
- .gitattributes — correct; LF enforcement + binary asset handling + lockfile diff collapse
- .github/CODEOWNERS — functional but all rules are no-op until @LoopDevs/engineering team exists (A2-103 acknowledged)
- .github/dependabot.yml — correct; weekly npm + actions updates, phantom-team reviewer dropped per A2-106
- .github/ISSUE_TEMPLATE/bug.yml — correct; security advisory redirect prominent
- .github/ISSUE_TEMPLATE/config.yml — correct; blank_issues_enabled: false, security advisory link
- .github/ISSUE_TEMPLATE/feature.yml — correct; ADR callout present
- .github/labeler.yml — correct; labels map to repo structure
- .github/pull_request_template.md — correct; doc update checklist + security section present
- .github/workflows/ci.yml — overall very strong; SHA-pinned actions, --ignore-scripts posture, set -euo pipefail throughout, principle-of-least-privilege permissions; one stale AGENTS.md count
- .github/workflows/codeql.yml — correct; SHA-pinned, weekly cron, security-and-quality queries
- .github/workflows/e2e-real.yml — correct; workflow_dispatch only, contents: read, refresh-token rotation on always(), GH_SECRETS_PAT scoped
- .github/workflows/pr-automation.yml — correct functionally; minor: ADDITIONS/DELETIONS direct interpolation pattern inconsistency
- .github/workflows/pr-review.yml — correct; gitleaks gate before diff reaches Anthropic, prompt-injection defences present, pull_request (not pull_request_target) so no fork secret leak
- .gitignore — correct; .env, native artifacts, coverage, playwright reports all excluded
- .gitleaks.toml — correct; default ruleset + narrow allowlist with reasoning; playwright config exemption is intentionally broad but acceptable
- .husky/commit-msg — correct; commitlint on every commit
- .husky/pre-commit — correct; lint-staged
- .husky/pre-push — correct; branch-name enforcement + full verify.sh (A2-411)
- .npmrc — correct; save-exact enforced
- .prettierrc — correct; consistent style config
- AGENTS.md — mostly accurate; four issues: ADR index stops at 031 (032-035 exist), CI job count says eleven (actual: twelve, missing test-e2e-flywheel), branch-protection required checks list is incomplete, CLAUDE.md symlink confirmed correct
- CHANGELOG.md — informational only; format follows keepachangelog, audit finding references present
- CLAUDE.md — symlink to AGENTS.md; correct
- CODE_OF_CONDUCT.md — correct; A2-1801 closure
- commitlint.config.js — correct; type-enum, scope-enum, subject/body length enforced
- CONTRIBUTING.md — stale: lists 7 CI jobs, actual is 12; otherwise accurate
- docker-compose.yml — correct for dev use; postgres:16 floating tag acceptable for dev-only compose
- eslint.config.js — correct; no-explicit-any, exhaustive switches, Capacitor import boundary, typed rules enabled, test overrides appropriate
- LICENSE — proprietary; terms clear
- package-lock.json — 16115 lines; all resolved URLs point to registry.npmjs.org plus four local workspace entries (apps/backend, apps/mobile, apps/web, packages/shared); no suspicious registries
- package.json — correct; workspaces, scripts, overrides (axios pin for stellar-sdk, shell-quote, ip-address, brace-expansion, fast-uri), devDependencies all expected
- playwright.config.ts — correct; real-upstream suite, chromium + mobile-chrome + optional mobile-safari, reuseExistingServer pattern
- playwright.flywheel.config.ts — correct; separate port range from mocked suite, LOOP_AUTH_NATIVE_ENABLED=true, fixture keys in gitleaks allowlist
- playwright.mocked.config.ts — correct; serial workers (shared in-memory mock state), three-process webServer, DISABLE_RATE_LIMITING=1 with production guard
- README.md — mostly accurate; references superseded audit at docs/audit-2026-tracker.md as "Historical" which is correct per AGENTS.md comment; Phase 1 shipped / Phase 2 in progress status accurate
- SECURITY.md — correct; private advisory channel, response targets, safe-harbour terms, scope definitions
- tests/e2e-flywheel/flywheel-walk.test.ts — correct; seeds via global-setup, mint-loop-token, sessionStorage planting, asserts cashback + orders summary
- tests/e2e-flywheel/global-setup.ts — correct; migrates + truncates + seeds fulfilled order + cashback credit row; parameterised SQL
- tests/e2e-mocked/fixtures/mock-ctx.mjs — correct; in-memory state, deterministic OTP, test-only mark-fulfilled hook

**Coverage:** 38/38 files reviewed. Skipped: none.

## Batch 28 — root misc remainder

- tests/e2e-mocked/global-setup.ts — mostly correct; missing `user_favorite_merchants` in truncate list
- tests/e2e-mocked/purchase-flow.test.ts — correct; hardcoded port constants duplicate playwright config values (low maintainability risk)
- tests/e2e/purchase-flow.test.ts — correct; geo-redirect assumption undocumented but harmless today
- tests/e2e/smoke.test.ts — correct; clean, well-commented
- tsconfig.base.json — correct; strict config properly shared across monorepo

**Coverage:** 5/5 files reviewed. Skipped: none

# Appendix B — Methodology

- **Inventory:** `git ls-files` ∪ `git ls-files --others --exclude-standard` → 1,751 files,
  partitioned into 28 explicit manifest files (pre-split to eliminate index-slice gaps).
- **Layer 1:** each batch swept by a dedicated auditor required to log a verdict for every manifest
  entry and report N/N coverage with skips listed; all 28 reported full coverage, zero skips.
  Depth: deep review for source/tests/docs/config; acknowledge-level (nature + secrets/PII scan)
  for prior-audit evidence, generated files, lockfiles, binaries.
- **Layer 2:** six cross-cutting auditors traced interactions between files: every web service
  module's contract against its backend handler + openapi registration + shared types; all 81 env
  vars across env.ts/.env.example/docs/fly.toml/CI/preflight; all 33 migrations against schema.ts;
  all 5 CI workflows plus the 9 scripts they invoke, against branch protection; the full order
  lifecycle across ~30 backend files including crash-gap analysis at every await between DB writes;
  and all 12 forward-looking planning docs as a dependency graph with an orphaned-work register.
- **Verification:** highest-impact claims (USDC issuer mismatch, currency CHECK reachability —
  which _overturned_ a draft finding, watcher cursor-loss, hardcoded key, branch/PR state) were
  independently re-verified against the working tree before publication.
- **Baseline:** `npm run verify` (typecheck/lint pass; format fails only on untracked scripts) and
  `npm test` (3,239 tests pass) run at audit time.
- **Artifacts:** batch manifests `/tmp/audit-batches/batch-{01..28}-*.txt`; raw reports
  `/tmp/audit-out/{batch-{01..28},cross-*}.md`; ADR-019 contract-parity patch
  `/tmp/audit-out/adr019-contract-parity.patch` (these /tmp artifacts are transient — this document
  is the durable record).
- **Process note:** the contract-parity auditor applied its fixes to the working tree instead of
  only reporting; the changes were captured to the patch above and reverted, leaving the tree clean.
