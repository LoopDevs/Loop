# Sweep: Docs/env-parity + test vacuity — raw findings

Method: COLD. Every claim below was independently re-derived from the
current `main` tree (not from prior audit reports) — env-var lists were
extracted directly from `apps/backend/src/env.ts` / `.env.example` /
`AGENTS.md` / `docs/development.md` / `docs/deployment.md` with
hand-verified regexes (a first extraction pass had a silent BSD-sed
`\s`-portability bug that was caught and fixed before any numbers were
trusted — see Methodology note at the end), `scripts/lint-docs.sh` was
actually executed (not just read), and the dead-link sweep parsed every
markdown link in the tree and checked the target on disk. Three
sub-agents handled the per-package `AGENTS.md` spot-check and the
backend/web test-vacuity sampling; their results are folded in below
with attribution, and I independently corroborated a sample of each
(see Coverage confirmation).

Per the brief: v-observability.md and v-platform.md already found and
filed doc-drift in their scope (PLAT-30-07 — `ADMIN_EMAILS` missing
from `AGENTS.md`; PLAT-30-04 — `env.test.ts` missing coverage for 4 new
vars; v-observability F-2 — `disaster-recovery.md`'s stale
`$LOOP_STELLAR_OPERATOR_ID`; CF-11's step-up-handler test gap). None of
those are re-filed here. This sweep independently re-confirmed all of
them are still true (see Coverage confirmation) and found the **scope**
of the `AGENTS.md` env-var gap is far larger than PLAT-30-07 reported
(49 vars, not 2).

---

## Env-var parity matrix

86 env vars total (union of `env.ts` schema keys and `.env.example`
entries — these two are in perfect 86/86 parity). Columns: present in
`env.ts` / `.env.example` / `AGENTS.md` (root) / `docs/development.md`
/ `docs/deployment.md`. **49 of 86 vars (57%) have at least one gap —
all 49 are the same shape: present everywhere except `AGENTS.md`.**

| Var                                            | env.ts | .env.example | AGENTS.md | development.md | deployment.md  |
| ---------------------------------------------- | ------ | ------------ | --------- | -------------- | -------------- |
| `ADMIN_CTX_USER_IDS` ⚠️                        | Y      | Y            | **✗**     | Y              | Y              |
| `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR` ⚠️          | Y      | Y            | **✗**     | Y              | Y              |
| `ADMIN_EMAILS` ⚠️                              | Y      | Y            | **✗**     | Y              | Y              |
| `APPLE_SIGN_IN_SERVICE_ID` ⚠️                  | Y      | Y            | **✗**     | Y              | Y              |
| `CTX_CLIENT_ID_ANDROID`                        | Y      | Y            | Y         | Y              | Y              |
| `CTX_CLIENT_ID_IOS`                            | Y      | Y            | Y         | Y              | Y              |
| `CTX_CLIENT_ID_WEB`                            | Y      | Y            | Y         | Y              | Y              |
| `CTX_OPERATOR_POOL` ⚠️                         | Y      | Y            | **✗**     | Y              | Y              |
| `DATABASE_POOL_MAX` ⚠️                         | Y      | Y            | **✗**     | Y              | Y              |
| `DATABASE_STATEMENT_TIMEOUT_MS` ⚠️             | Y      | Y            | **✗**     | Y              | Y              |
| `DATABASE_URL` ⚠️                              | Y      | Y            | **✗**     | Y              | Y              |
| `DEFAULT_LOOP_MARGIN_PCT_OF_CTX` ⚠️            | Y      | Y            | **✗**     | Y              | Y              |
| `DEFAULT_USER_CASHBACK_PCT_OF_CTX` ⚠️          | Y      | Y            | **✗**     | Y              | Y              |
| `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT` ⚠️ | Y      | Y            | **✗**     | (prose only)\* | (prose only)\* |
| `DISABLE_RATE_LIMITING` ⚠️                     | Y      | Y            | **✗**     | Y              | Y              |
| `DISCORD_WEBHOOK_ADMIN_AUDIT` ⚠️               | Y      | Y            | **✗**     | Y              | Y              |
| `DISCORD_WEBHOOK_MONITORING`                   | Y      | Y            | Y         | Y              | Y              |
| `DISCORD_WEBHOOK_ORDERS`                       | Y      | Y            | Y         | Y              | Y              |
| `EMAIL_FROM_ADDRESS`                           | Y      | Y            | Y         | Y              | Y              |
| `EMAIL_FROM_NAME`                              | Y      | Y            | Y         | Y              | Y              |
| `EMAIL_PROVIDER`                               | Y      | Y            | Y         | Y              | Y              |
| `EMAIL_REPLY_TO_ADDRESS`                       | Y      | Y            | Y         | Y              | Y              |
| `GIFT_CARD_API_BASE_URL`                       | Y      | Y            | Y         | Y              | Y              |
| `GIFT_CARD_API_KEY`                            | Y      | Y            | Y         | Y              | Y              |
| `GIFT_CARD_API_SECRET`                         | Y      | Y            | Y         | Y              | Y              |
| `GOOGLE_OAUTH_CLIENT_ID_ANDROID` ⚠️            | Y      | Y            | **✗**     | Y              | Y              |
| `GOOGLE_OAUTH_CLIENT_ID_IOS` ⚠️                | Y      | Y            | **✗**     | Y              | Y              |
| `GOOGLE_OAUTH_CLIENT_ID_WEB` ⚠️                | Y      | Y            | **✗**     | Y              | Y              |
| `IMAGE_PROXY_ALLOWED_HOSTS`                    | Y      | Y            | Y         | Y              | Y              |
| `INCLUDE_DISABLED_MERCHANTS`                   | Y      | Y            | Y         | Y              | Y              |
| `INTEREST_APY_BASIS_POINTS` ⚠️                 | Y      | Y            | **✗**     | Y              | Y              |
| `INTEREST_PERIODS_PER_YEAR` ⚠️                 | Y      | Y            | **✗**     | Y              | Y              |
| `INTEREST_TICK_INTERVAL_HOURS` ⚠️              | Y      | Y            | **✗**     | Y              | Y              |
| `LOCATION_REFRESH_INTERVAL_HOURS`              | Y      | Y            | Y         | Y              | Y              |
| `LOG_LEVEL`                                    | Y      | Y            | Y         | Y              | Y              |
| `LOOP_ADMIN_STEP_UP_SIGNING_KEY`               | Y      | Y            | Y         | Y              | Y              |
| `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` ⚠️   | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_ASSET_DRIFT_THRESHOLD_STROOPS` ⚠️        | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS` ⚠️ | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_AUTH_NATIVE_ENABLED`                     | Y      | Y            | Y         | Y              | Y              |
| `LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS`           | Y      | Y            | Y         | Y              | Y              |
| `LOOP_AUTH_ROW_RETENTION_DAYS`                 | Y      | Y            | Y         | Y              | Y              |
| `LOOP_ENV`                                     | Y      | Y            | Y         | Y              | Y              |
| `LOOP_FX_FEED_URL` ⚠️                          | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_INTEREST_POOL_ACCOUNT` ⚠️                | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_INTEREST_POOL_MIN_DAYS_COVER` ⚠️         | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_JWT_SIGNING_KEY`                         | Y      | Y            | Y         | Y              | Y              |
| `LOOP_JWT_SIGNING_KEY_PREVIOUS`                | Y      | Y            | Y         | Y              | Y              |
| `LOOP_KILL_AUTH`                               | Y      | Y            | Y         | Y              | Y              |
| `LOOP_KILL_ORDERS`                             | Y      | Y            | Y         | Y              | Y              |
| `LOOP_KILL_ORDERS_LEGACY`                      | Y      | Y            | Y         | Y              | Y              |
| `LOOP_KILL_ORDERS_LOOP`                        | Y      | Y            | Y         | Y              | Y              |
| `LOOP_KILL_WITHDRAWALS`                        | Y      | Y            | Y         | Y              | Y              |
| `LOOP_MERCHANT_DENYLIST` ⚠️                    | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYMENT_WATCHER_INTERVAL_SECONDS` ⚠️     | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYOUT_FEE_BASE_STROOPS` ⚠️              | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYOUT_FEE_CAP_STROOPS` ⚠️               | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYOUT_FEE_MULTIPLIER` ⚠️                | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYOUT_MAX_ATTEMPTS` ⚠️                  | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYOUT_WATCHDOG_STALE_SECONDS` ⚠️        | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PAYOUT_WORKER_INTERVAL_SECONDS` ⚠️       | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_PHASE_1_ONLY`                            | Y      | Y            | Y         | Y              | Y              |
| `LOOP_PROCUREMENT_INTERVAL_SECONDS` ⚠️         | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_REDEEM_ENCRYPTION_KEY`                   | Y      | Y            | Y         | Y              | Y              |
| `LOOP_STELLAR_DEPOSIT_ADDRESS` ⚠️              | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_EURLOOP_ISSUER` ⚠️               | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_GBPLOOP_ISSUER` ⚠️               | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_HORIZON_URL` ⚠️                  | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_NETWORK_PASSPHRASE` ⚠️           | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_OPERATOR_SECRET` ⚠️              | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS` ⚠️     | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_USDC_FLOOR_STROOPS` ⚠️           | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_USDC_ISSUER` ⚠️                  | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_STELLAR_USDLOOP_ISSUER` ⚠️               | Y      | Y            | **✗**     | Y              | Y              |
| `LOOP_WORKERS_ENABLED`                         | Y      | Y            | Y         | Y              | Y              |
| `LOOP_XLM_PRICE_FEED_URL` ⚠️                   | Y      | Y            | **✗**     | Y              | Y              |
| `MAXMIND_GEOLITE2_PATH` ⚠️                     | Y      | Y            | **✗**     | Y              | Y              |
| `METRICS_BEARER_TOKEN` ⚠️                      | Y      | Y            | **✗**     | Y              | Y              |
| `NODE_ENV`                                     | Y      | Y            | Y         | Y              | Y              |
| `OPENAPI_BEARER_TOKEN` ⚠️                      | Y      | Y            | **✗**     | Y              | Y              |
| `PORT`                                         | Y      | Y            | Y         | Y              | Y              |
| `REFRESH_INTERVAL_HOURS`                       | Y      | Y            | Y         | Y              | Y              |
| `RESEND_API_KEY`                               | Y      | Y            | Y         | Y              | Y              |
| `SENTRY_DSN`                                   | Y      | Y            | Y         | Y              | Y              |
| `SENTRY_RELEASE` ⚠️                            | Y      | Y            | **✗**     | Y              | Y              |
| `TRUST_PROXY`                                  | Y      | Y            | Y         | Y              | Y              |

\* `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT` is mentioned in prose in
both `development.md:170` and `deployment.md:73` (inline in the
`IMAGE_PROXY_ALLOWED_HOSTS` row's description: "...unless
`DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1` is set") but never gets
its own dedicated `VAR=value` line / table row in either doc. Cosmetic
— not counted as a real gap in the finding below, but flagged here
for completeness since the matrix-building script's first pass (which
only matched dedicated lines) flagged it as fully absent.

**Bottom line:** `env.ts` ⇄ `.env.example` ⇄ `development.md` ⇄
`deployment.md` are in clean, complete parity (modulo the one cosmetic
case above). `AGENTS.md`'s "Environment variables (summary)" section
is the only document with a real, large, and apparently-growing gap.
See DT-01.

---

## Dead-link results

Parsed every `[text](target)` markdown link across all 329 markdown
files in `docs/`, root `AGENTS.md`/`README.md`, and the three
per-package `AGENTS.md`/`README.md` files (856 local-file-path links
checked; external `http(s)://`/`mailto:` links excluded by design).

**Result: 0 genuine dead links.** The one apparent hit
(`docs/audit-2026-05-03/findings/register.md:580` →
`apps/web/.env.local`) is an audit evidence citation to the
_operator's_ local, git-ignored dev env file — intentionally absent
from the repository, not a doc defect. No reference-style
(`[text]: target`) links exist anywhere in the tree.

This is a genuinely clean result — internal documentation cross-links
in this repository are well-maintained. Not filed as a finding.

---

## Vacuous-test sample results

100 test files sampled in total across this sweep: 40 by direct agent
read (backend money/auth/admin — "Test vacuity sweep — backend"
sub-agent) + 36 by direct agent read (web — "Test vacuity sweep — web"
sub-agent) + ~24 read directly by me as independent corroboration
(`apps/backend/src/credits/__tests__/{ledger-invariant,withdrawals}.test.ts`,
`apps/backend/src/admin/__tests__/credit-adjustments.test.ts`,
`apps/backend/src/auth/__tests__/require-admin.test.ts`,
`apps/backend/src/orders/__tests__/{redemption,redemption-backfill}.test.ts`,
`apps/backend/src/credits/__tests__/interest-scheduler.test.ts`,
`apps/web/app/native/__tests__/secure-storage-native.test.ts`, plus
file-existence/coverage cross-checks). Well above the 40-50 minimum.

| Test file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pattern found                                                                                                                                                                                            | Verdict                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/web/app/components/features/purchase/__tests__/RedeemFlow.test.tsx:60-65`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | mock wired but never asserted on; would pass with the handler deleted                                                                                                                                    | **Vacuous**                                |
| `apps/web/app/components/features/admin/__tests__/CreditAdjustmentForm.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | only the pure `parseAmountMajor` helper is tested; the 273-line ledger-write component is never rendered                                                                                                 | **Weak (coverage gap)**                    |
| `apps/web/app/components/features/admin/__tests__/AdminWithdrawalForm.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | same shape — only `parseUnsignedAmountMajor` tested                                                                                                                                                      | **Weak (coverage gap)**                    |
| `apps/web/app/native/__tests__/native-modules.test.ts` (728 ln)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | entire file runs with `isNativePlatform() === false`; biometrics/notifications native branches have zero coverage anywhere                                                                               | **Weak (structural gap)**                  |
| `apps/web/app/native/__tests__/{app-lock.native,secure-storage-native}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | real in-memory fakes, exact-state assertions, migration/precedence logic genuinely exercised                                                                                                             | **Good**                                   |
| `apps/web/app/utils/__tests__/format-stellar.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | exact-string assertions across negative/sub-unit/large-bigint/null/garbage                                                                                                                               | **Good**                                   |
| `apps/web/app/services/__tests__/{auth,orders,user,orders-loop}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `toHaveBeenCalledWith` on wire-shaping functions — call-args assertion _is_ the real behavior here                                                                                                       | **Borderline-fine, not vacuous**           |
| `apps/web/app/components/features/{admin,cashback,purchase,order,wallet}/__tests__/*`, `routes/__tests__/{admin.payouts.$id,admin.orders.$orderId,settings.wallet}.test.tsx`, `hooks/__tests__/*` (≈20 files)                                                                                                                                                                                                                                                                                                                                                                                                                  | exact rendered money strings, full step-up→retry→idempotency-reuse flows                                                                                                                                 | **Good**                                   |
| `apps/backend/src/credits/__tests__/adjustments.test.ts:292-307`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | cap-sum mock returns `0`; never proves currency-scoping in the underlying query                                                                                                                          | **Weak**                                   |
| `apps/backend/src/credits/__tests__/liabilities.test.ts:58-65`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | self-admitted in its own comment: only checks `.where()` was called once, not which currency                                                                                                             | **Vacuous (self-admitted)**                |
| `apps/backend/src/credits/__tests__/accrue-interest.test.ts` (whole file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | no test ever gives one `userId` two currency rows — the exact A2-610 cross-currency-clobber bug class the module exists to fix is unreproducible by this suite                                           | **Weak (gap)**                             |
| `apps/backend/src/payments/__tests__/payout-worker.test.ts:630-646`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | "processes rows in order" only counts `submitPayout` calls, never checks non-overlap — the CF-14 sequence-collision regression this test is named for would slip through                                 | **Vacuous**                                |
| `apps/backend/src/payments/__tests__/payout-worker.test.ts:516-536`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | CF-18 fail-closed test checks `confirmed === 0` but never `failed`/`markPayoutFailed` — a silently-stuck row would pass                                                                                  | **Weak**                                   |
| `apps/backend/src/payments/payout-submit.ts` `submitNativePayment`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | zero direct unit coverage anywhere; mocked away wholesale in its only caller's test; this is the real-money CTX-forward function with a documented history (per project memory) of stranding paid orders | **Vacuous-by-omission**                    |
| `apps/backend/src/admin/__tests__/credit-adjustments.test.ts:359-399`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | asserts `audit.replayed === false` on replay — the literal opposite of what production `withIdempotencyGuard` actually sets (`true`); actively wrong as documentation                                    | **Vacuous / actively misleading**          |
| `apps/backend/src/admin/__tests__/{withdrawals,payout-compensation,refunds}.test.ts` (happy-path + replay tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | never capture `reason` in the ledger-write assertion or parse `res.json()`'s `audit.replayed` on replay tests                                                                                            | **Weak**                                   |
| `apps/backend/src/auth/__tests__/tokens.test.ts:163-191`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `iss`-claim test tampers the claim without re-signing, so it fails on signature-mismatch first; the real `iss !== LOOP_JWT_ISSUER` branch is never genuinely hit (same gap for `aud`)                    | **Vacuous**                                |
| `apps/backend/src/auth/__tests__/otps.test.ts:139-167`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `markOtpConsumed`/`incrementOtpAttempts` tests only check `update`/`set` were called, never `.where()` args — cannot distinguish "consume the right row" from "consume every row"                        | **Vacuous**                                |
| `apps/backend/src/auth/__tests__/refresh-tokens.test.ts:216-223`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `revokeAllRefreshTokensForUser` (A2-1608 token-theft kill switch) never verifies the update is scoped to `userId` — an unscoped mass-logout regression would pass                                        | **Vacuous**                                |
| `apps/backend/src/orders/__tests__/transitions.test.ts:83-89` + 5 dependents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | mock `.where()` ignores predicate args entirely — the order state-machine guard (no illegal/duplicate transitions) is structurally unverifiable by this suite                                            | **Vacuous**                                |
| `apps/backend/src/orders/__tests__/loop-handler.test.ts:245-257`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | test name claims to cover both "unknown" and "disabled" merchant, but `enabled === false` is never constructed in the 873-line file                                                                      | **Weak (misleading test name)**            |
| `apps/backend/src/__tests__/env.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | no test feeds an invalid-length signing/encryption key to confirm `parseEnv` actually throws at boot                                                                                                     | **Weak (gap — already known, PLAT-30-04)** |
| `apps/backend/src/credits/__tests__/{ledger-invariant,withdrawals,payout-builder,refunds,payout-compensation}.test.ts`, `apps/backend/src/admin/__tests__/credit-adjustments.test.ts` (status/error-mapping checks), `apps/backend/src/auth/__tests__/require-admin.test.ts` (explicit 404-not-403 verification), `apps/backend/src/payments/__tests__/payout-submit.test.ts`, `apps/backend/src/auth/__tests__/native-refresh-race.test.ts` (real concurrent CAS race), `apps/backend/src/orders/__tests__/redeem-crypto.test.ts` (real AES-256-GCM tamper tests), `apps/backend/src/__tests__/bigint-money-property.test.ts` | exact bigint/balance/currency assertions, real attacker/edge scenarios, no mock-only patterns                                                                                                            | **Good — independently confirmed by me**   |

**Recurring anti-pattern (backend):** a chainable Drizzle-mock helper
whose `.where()` ignores its predicate arguments and just returns a
pre-staged array, used identically across at least 4 files/areas
(`credits/liabilities.test.ts`, `orders/transitions.test.ts`,
`auth/otps.test.ts`, `credits/adjustments.test.ts`). This is a single
shared mock-design flaw, not 4 independent bugs — see DT-19.

---

## False-comment-claim findings

Backend (`apps/backend/src`): grep for
`covered by|tested in|see test|covered in|tested by` outside
`__tests__/` returns 1 hit, a false-positive ("recovered by", not
"covered by"). Broadened to also include `__tests__/` files (since
coverage claims more often live in test-file docstrings referencing
sibling test files) and broadened phrasing
(`regression test for|guards against|prevents regression`): 11 real
claims found and verified.

Web (`apps/web/app`): the same grep (including broadened variants)
returns **zero** hits anywhere in `apps/web/app` — confirmed the grep
mechanics work by sanity-checking it against backend first.

| Location                                                                                                                                                                                                                                                                                 | Claim                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/__tests__/integration/admin-writes.test.ts:89`                                                                                                                                                                                                                         | "the step-up minting flow itself (covered by unit tests)"           | **Confirmed true but the referenced unit tests (`admin-step-up.test.ts`, `admin-step-up-middleware.test.ts`) cover the token primitive + the gate middleware, not `admin/step-up-handler.ts`'s actual `POST /api/admin/step-up` HTTP handler — no test file targets that handler directly. This is CF-11's already-known gap; independently re-confirmed, not re-filed.** |
| `apps/backend/src/orders/__tests__/redemption-backfill.test.ts:15`                                                                                                                                                                                                                       | "its own fetch/parse behaviour is covered by `redemption.test.ts`"  | **TRUE** — `redemption.test.ts` exercises `fetchRedemption`'s real zod-parse + alias-collapsing logic (verified the `code`/`pin`/`url` alias shape is fed in at line 75 of that file, not just the canonical `redeemCode`/`redeemPin`/`redeemUrl` shape), with only the transport layer (`operatorFetch`) mocked.                                                         |
| `apps/backend/src/credits/__tests__/interest-scheduler.test.ts:7`                                                                                                                                                                                                                        | "`accrueOnePeriod` is already covered by `accrue-interest.test.ts`" | **PARTIALLY TRUE** — `accrue-interest.test.ts` is real and substantial, but (per the vacuous-test finding above) never reconstructs the one regression class (A2-610 cross-currency clobbering) the module's own header calls out by name. "Covered" overstates what's actually pinned.                                                                                   |
| `apps/backend/src/admin/audit-tail-csv.ts:93-98`, `orders/procurement.ts:36-39`, `orders/handler.ts:170-182`, `credits/accrue-interest.ts:59`, `middleware/rate-limit.ts:62-66`, `test-endpoints.ts:26-28`, `public/cashback-preview.ts:102-105`, `db/client.ts:34-41`, `index.ts:68-70` | various "covered by"/"tested in" claims                             | **TRUE** (9 of 9 verified)                                                                                                                                                                                                                                                                                                                                                |
| `apps/backend/src/orders/__tests__/ctx-contract.test.ts:120`                                                                                                                                                                                                                             | "every fixture in the directory is covered by a contract case"      | **TRUE** (self-referential coverage-completeness test, verified the fixture-enumeration logic actually walks the directory)                                                                                                                                                                                                                                               |

**Net: of 12 distinct coverage-claiming comments checked across both
backend and web, 10 are straightforwardly true, 1 is partially true
(overstated), and 1 points at real-but-too-narrow coverage (the
already-known CF-11 gap).** This codebase's "covered by X" comments are,
on the whole, honest — better than the brief's framing led us to
expect going in. The one new finding here (interest-scheduler.ts:9
overselling "thorough" coverage) is folded into DT-18 below rather than
filed standalone, since it's the same root issue as the
`accrue-interest.test.ts` gap.

---

## Findings

### DT-01 [P2 · LIVE] `AGENTS.md`'s env-var summary is missing 49 of 86 backend env vars — including every Stellar secret, the DB connection string, and both admin allowlists

- File: `AGENTS.md` "Environment variables (summary)" section (root), vs. `apps/backend/src/env.ts` (86-var schema), `apps/backend/.env.example`, `docs/development.md`, `docs/deployment.md` (all three in full parity — see matrix above).
- Evidence: see the full matrix above. 49 vars are present in `env.ts`/`.env.example`/`development.md`/`deployment.md` but absent from `AGENTS.md`, including `DATABASE_URL`, `ADMIN_EMAILS`, `ADMIN_CTX_USER_IDS`, `DISABLE_RATE_LIMITING`, `METRICS_BEARER_TOKEN`, `OPENAPI_BEARER_TOKEN`, all 5 `LOOP_STELLAR_*_ISSUER`/`LOOP_STELLAR_OPERATOR_SECRET[_PREVIOUS]`/`LOOP_STELLAR_DEPOSIT_ADDRESS` vars, and all 12 payout-fee/payout-worker/interest/asset-drift worker-tuning vars. PLAT-30-07 (v-platform.md) already flagged `ADMIN_EMAILS` specifically; this sweep independently confirms that finding and shows it's one instance of a 49-var pattern, not an isolated miss.
- Root cause, with direct evidence: commit `ddae90a7` (CF-30, "native-auth admin grant") — the PR's own commit message states _"Docs: ADMIN_EMAILS added to .env.example, development.md, deployment.md"_, literally enumerating 3 of the 4 locations the project's own doc-update-rules table requires (`AGENTS.md` is rule-required but not in that list) and the diff (`git show --stat ddae90a7`) confirms `AGENTS.md` was not touched. This is a systematic blind spot in how env-var PRs satisfy the doc-update checklist, not one missed edit.
- Impact: `AGENTS.md` is "the first thing AI agents read" per its own closing line. An agent or new engineer skimming it for "what env vars exist / how do I configure Stellar rails / how do I grant admin" gets a materially incomplete picture — notably, neither admin-grant mechanism (`ADMIN_EMAILS`, `ADMIN_CTX_USER_IDS`) nor any of the 5 Stellar secret/issuer vars appear at all.
- Minimal fix: Add the 49 missing vars to `AGENTS.md`'s env summary, prioritizing the safety-critical subset first (`DATABASE_URL`, `ADMIN_EMAILS`, `ADMIN_CTX_USER_IDS`, the 5 `LOOP_STELLAR_*` vars, `METRICS_BEARER_TOKEN`, `OPENAPI_BEARER_TOKEN`, `DISABLE_RATE_LIMITING`).
- Better fix: Stop hand-maintaining `AGENTS.md`'s env summary as a manually-curated subset that silently drifts. Either (a) extend `scripts/lint-docs.sh` to mechanically diff `env.ts` against `AGENTS.md` the same way it already diffs `env.ts` against `.env.example` (with an explicit, version-controlled exclusion list for the genuinely-omittable internal-tuning vars), or (b) auto-generate the `AGENTS.md` section from `env.ts`'s own JSDoc comments via a small script run in `npm run lint:docs`, removing the manual-sync failure mode at its root. Either way, also close the upstream root cause: add an `AGENTS.md` checkbox to the env-var doc-update-rule row so future PRs (modeled on CF-30) don't reproduce the same 3-of-4 pattern.

### DT-02 [P2 · LIVE] `scripts/lint-docs.sh`'s env-var parity check is one-directional and only covers `.env.example` — it has zero ability to catch the DT-01 gap

- File: `scripts/lint-docs.sh:15-28` (§1, the only env-var-related check in the entire script).
- Evidence: Ran the script in full (`bash scripts/lint-docs.sh`) — it passes cleanly with 0 errors despite the 49-var `AGENTS.md` gap above, because §1 only extracts vars from `env.ts` and checks each appears in `.env.example`; it never touches `AGENTS.md`, `docs/development.md`, or `docs/deployment.md`. It also doesn't check the reverse direction (an orphaned var in `.env.example` no longer in `env.ts` would similarly go undetected) — moot today since the two are in perfect parity, but unguarded going forward.
- Impact: explains why the DT-01 gap has been allowed to grow to 49 vars across at least one full release cycle (CF-30 and presumably several PRs before it) without CI ever flagging it — there is no mechanical gate for `AGENTS.md` env-var completeness at all, only human diligence, which the evidence in DT-01 shows is unreliable for this specific doc.
- Minimal fix: Add a new §1b to `lint-docs.sh` that extracts every backtick-or-shell-style env-var token from `docs/development.md` and `docs/deployment.md` (currently both in full parity — this just turns today's accidentally-correct state into a guaranteed one) and fails if any `env.ts` var is missing from either.
- Better fix: Also add a §1c, scoped only to vars `deployment.md`'s table marks `Required` (prod or native), that fails if any of those specific vars is absent from `AGENTS.md` — this protects the safety-critical subset (the priority list in DT-01's minimal fix) without forcing every internal worker-tuning knob into the cockpit doc, respecting `AGENTS.md`'s own "(summary)" framing while still closing the part of the gap that matters operationally.

### DT-03 [P2 · LIVE] `CHANGELOG.md` is abandoned — last updated 2026-04-24, missing 574 commits and the entire CF-series remediation wave

- File: `CHANGELOG.md` (root).
- Evidence: `git log -1 --format="%ai" -- CHANGELOG.md` → `2026-04-24 02:23:34 +0100` (commit `8a94634d`, "docs(infra): close A2-127 — add CHANGELOG.md"). `git log --oneline 8a94634d..HEAD | wc -l` → 574 commits since. Sampling the last 30 commit subjects shows the entire `CF-02` through at least `CF-36` remediation wave (≈25+ merged PRs: redemption-code encryption, `FOR UPDATE SKIP LOCKED` payout claims, extended-currency markets, accessibility hardening, step-up admin gating, mobile Sign-in-with-Apple, CSV formula-injection guards, country-aware merchant slugs, the bundle-budget/migration-parity/openapi-parity CI gates, and the entire `comprehensive-audit-2026-06-11` + `audit-2026-06-15-cold` remediation cycles) — none of it is reflected.
- Impact: `CHANGELOG.md`'s own header claims "All notable changes to this project are documented here" and describes the `Unreleased` section as live-updated per merged PR. Both claims are currently false. Low functional impact (no security/correctness exposure — it's a project-hygiene doc), but it actively misleads anyone using it to understand recent history, and it's specifically cross-referenced by the audit-remediation process ("Audit-remediation PRs reference the finding ID... so the audit-tracker and the changelog point at the same work" — that linkage has been silently broken for two-plus months of audit-remediation work).
- Minimal fix: Add a banner at the top acknowledging the changelog is not currently maintained past 2026-04-24 and pointing readers at `git log` / merged-PR history in the interim, so the doc stops actively misleading. (Backfilling 574 commits' worth of entries by hand is not a reasonable minimal fix.)
- Better fix: Automate changelog generation from Conventional Commit messages — the repo already enforces Conventional Commits via `commitlint` in CI (`AGENTS.md` git-workflow section, `.github/workflows/ci.yml`'s "Commitlint (PR commits)" step), so a tool like `release-please` or a small script that appends merged-PR titles/types to `CHANGELOG.md` on merge would remove the manual-upkeep failure mode this finding demonstrates is real.

### DT-04 [P2 · LIVE] `docs/audit-2026-06-15-cold/` — a complete, merged audit cycle — is entirely absent from `AGENTS.md`'s docs index, and the "Active audit tracker" callout is stale

- File: `AGENTS.md` docs-index table, rows for `docs/audit-2026-05-03-claude/tracker.md` ("**Active audit tracker**"), `docs/comprehensive-audit-2026-06-11.md`, `docs/audit-2026-04-29/`.
- Evidence: `docs/audit-2026-06-15-cold/` contains a full audit deliverable — `checklist.md`, `findings.md` (147 lines), `remediation-plan.md` (73 lines), `tracker.md`, `coverage-matrix.md`, and 18 `raw/v-*.md` vertical reports — merged via PR #1436 (`04c3fae0`, "docs: cold comprehensive audit 2026-06-15 — findings + remediation plan") on 2026-06-15. `grep -n "06-15-cold" AGENTS.md` returns zero matches. Meanwhile `AGENTS.md` bolds `docs/audit-2026-05-03-claude/tracker.md` as "**Active audit tracker**" — a round that predates 06-15-cold by six weeks — and separately lists the 06-11 comprehensive audit and the 04-29 scaffold, but skips straight over the most recent _completed_ round. (This very sweep's own brief, `docs/audit-2026-06-30-cold/checklist.md`, explicitly treats `docs/audit-2026-06-15-cold/checklist.md` as "the floor" to inherit from — proving the doc is actively load-bearing for agent-driven audit work today, not a historical artifact.)
- Impact: `AGENTS.md` is explicitly positioned as "the first thing AI agents read." An agent picking up audit-remediation or general "what's the current state of known issues" work, following only `AGENTS.md`'s docs index, would never discover `docs/audit-2026-06-15-cold/` exists — exactly the failure mode this very task's own briefing had to route around by being told the raw-report paths directly rather than relying on `AGENTS.md` to surface them.
- Minimal fix: Add a row for `docs/audit-2026-06-15-cold/` to `AGENTS.md`'s docs-index table, and update the "Active audit tracker" callout to point at whichever round is actually most current as of each edit.
- Better fix: This is now the third time in the project's history a newer audit round has superseded an older one without every downstream doc pointer catching up (2026-04 tracker → 05-03-claude → 06-11 comprehensive in parallel → 06-15-cold unlisted → 06-30-cold, this round, in progress). Replace the hand-maintained list of individual audit-round rows with a single pointer to a lightweight, append-only `docs/audit-INDEX.md` (one line per round: dates, finding count, status) that gets a one-line addition as a required step of every audit round's own kickoff/completion checklist, rather than relying on someone remembering to also edit `AGENTS.md` itself each time.

### DT-05 [P2 · LIVE] `apps/backend/AGENTS.md`'s Structure tree omits 6 entire directories and 13 top-level files, and undercounts subdirectory file counts by roughly 3-4x

_(Sub-agent finding, independently spot-checked by me: confirmed `middleware/`, `routes/`, `openapi/`, `webhooks/`, `discord/` subdirectory existence and the `health.ts` top-level file via direct `ls`.)_

- File: `apps/backend/AGENTS.md` lines 8-66 (Structure tree), vs. actual `apps/backend/src/` (589 `.ts` files including tests, 22 top-level files + 22 subdirectories).
- Evidence: six entire directories are missing from the tree — `middleware/` (11 files: cors, rate-limit, kill-switch, secure-headers, body-limit), `routes/` (19 files — the actual route-mount modules, see DT-06), `openapi/` (69 files — the real per-endpoint OpenAPI registrations; `openapi.ts` is now just a thin entry point), `scripts/` (3 files), `webhooks/` (1 file), `discord/` (9 files — `discord.ts` is now a re-export barrel). Thirteen top-level files are also unlisted, including `health.ts` (where `probeUpstream()` actually now lives — DT-07), `cleanup.ts`, `kill-switches.ts`, `circuit-breaker-registry.ts`. Within directories that _are_ listed, sub-counts are heavily stale: `credits/` lists 4 files vs. actual 17; `orders/` lists 8 files vs. actual 27 (missing `pay-ctx.ts` — the principal-switch fix the user's own project memory specifically flags as critical); `users/` lists 1 file vs. actual 18 (missing the entire DSR/GDPR-export surface).
- Impact: this is the primary orientation doc for any agent modifying backend code. It would not surface the existence of entire subsystems (DSR handlers, the routes/openapi module split, middleware boundaries) to someone reading it cold.
- Minimal fix: add the six missing directories as one-line entries with file counts; fix the most-understated sub-counts (`credits/`, `orders/`, `users/`).
- Better fix: regenerate the tree from `find apps/backend/src -name '*.ts'`, pruned to representative entries per directory the way `admin/` is already (correctly) summarized as "~60 files" rather than hand-enumerated — and keep that pattern consistently rather than enumerating some directories and abbreviating others.

### DT-06 [P2 · LIVE] `apps/backend/AGENTS.md`'s "add an endpoint" recipe tells you to register the route in `app.ts` — that's no longer how it works

*(Sub-agent finding, independently spot-checked by me: confirmed `app.ts:15-21` only imports/calls `mount*Routes()`functions and contains zero direct`app.get/post/put/delete` domain-route calls.)\*

- File: `apps/backend/AGENTS.md` line 103 ("Register the route in `src/app.ts`"), vs. `apps/backend/src/app.ts:15-21,132-174` and `apps/backend/src/routes/*.ts`.
- Evidence: `app.ts` only imports and calls seven `mount*Routes(app)` functions (`mountMerchantRoutes`, `mountAuthRoutes`, `mountOrderRoutes`, `mountMiscRoutes`, `mountPublicRoutes`, `mountUserRoutes`, `mountAdminRoutes`); the actual `app.get/post/put/delete` calls live inside the relevant `src/routes/<domain>.ts` module. The root `AGENTS.md` already states this correctly ("every `app.get/post/put/delete` mount in `apps/backend/src/routes/**`"), so the two docs now actively contradict each other.
- Impact: an agent following this recipe literally would add a stray inline route directly to `app.ts`, bypassing the route-module mount-order and rate-limit conventions documented elsewhere.
- Minimal fix: change the step to "Register the route in the relevant `src/routes/<domain>.ts` module (mounted via `mount*Routes(app)` in `app.ts`)."
- Better fix: list the seven existing route modules by domain so the recipe can point to the correct one directly, and add a one-line cross-check note that this must stay consistent with the root `AGENTS.md`'s middleware-stack description (which already got this right).

### DT-07 [P3 · LIVE] `apps/backend/AGENTS.md` says `probeUpstream()` lives in `app.ts` — it's actually in `health.ts`

_(Sub-agent finding.)_

- File: `apps/backend/AGENTS.md` line 81, vs. `apps/backend/src/health.ts:142,188` and `apps/backend/src/app.ts:127`.
- Evidence: `probeUpstream` is defined and called entirely within `health.ts`; `app.ts`'s `/health` route is now just `app.get('/health', healthHandler)`, importing the handler from `./health.js`.
- Minimal fix: change "in `app.ts`" to "in `health.ts`".
- Better fix: covered by DT-05's fix (add `health.ts` to the Structure tree) so this class of stale pointer is less likely to recur silently.

### DT-08 [P2 · LIVE] `apps/web/AGENTS.md`'s route count and file list are stale, and omit 5 ADR-034 files including `home-geo-redirect.tsx` — one of only two documented loader exceptions in the whole codebase

_(Sub-agent finding, independently spot-checked by me: confirmed `home-geo-redirect.tsx` exists at `apps/web/app/routes/home-geo-redirect.tsx` and is the file the root `AGENTS.md`/`CLAUDE.md` names as a documented exception to the "web is a pure API client" rule.)_

- File: `apps/web/AGENTS.md` lines 9-12, vs. `apps/web/app/routes/` (40 `.tsx` files) and `apps/web/app/routes.ts` (~48 actual route registrations).
- Evidence: doc claims "35 routes"; actual file count is 40, actual registration count (counting the locale-layout's 11 children + 9 legacy mirrors + sitemap + 7 authed + 17 admin + splat) is ~48 — neither matches 35. The file list omits `trustlines.tsx`, `locale-layout.tsx`, `locale-layout-ssr.tsx`, `home-geo-redirect.tsx`, and `not-found-ssr.tsx`. `home-geo-redirect.tsx` is architecturally significant: it's one of exactly two routes the root `AGENTS.md` calls out by name as a deliberate exception to "Web is a pure API client" (ADR 034's server-side geo-redirect), yet it's invisible in the per-package guide meant to orient route work.
- Impact: an agent reading the web package guide to understand routing would miss a load-bearing architectural exception.
- Minimal fix: update the count and add the five missing files.
- Better fix: also document in the "Add a new route" recipe that public/catalog routes must be registered in _both_ `localeChildren` and the legacy top-level array per ADR 034's migration comment in `routes.ts:24-32` — the existing recipe only covers the single-`route()`-call case (authed/admin routes), not the dual-registration case that's now the common path for new public routes.

### DT-09 [P3 · LIVE] `apps/web/AGENTS.md` references two settings routes that don't exist and omits the one that does

_(Sub-agent finding.)_

- File: `apps/web/AGENTS.md` line 15 ("`settings.*.tsx` ← profile / wallet / cashback / home-currency"), vs. actual `settings.wallet.tsx`, `settings.cashback.tsx`, `settings.privacy.tsx`.
- Evidence: no `settings.profile.tsx` or `settings.home-currency.tsx` exists. Home-currency changes are admin/support-mediated post-first-order (`apps/backend/src/users/home-currency-change.ts:2-3`), consistent with this codebase's documented "admin-only user writes" pattern — so the doc line implies a self-serve surface that was never built (or was removed), and a real route (`settings.privacy.tsx`) goes unmentioned.
- Minimal fix: change to "`settings.*.tsx` ← wallet / cashback / privacy."
- Better fix: cross-reference `docs/architecture.md` to confirm there's no self-serve profile/home-currency surface anywhere, then align this line with that.

### DT-10 [P2 · LIVE] `apps/web/AGENTS.md`'s `services/` file table lists 11 files; the directory actually has 49 — the `admin.ts` barrel decomposition into 33 slices left no trace here

_(Sub-agent finding — corroborates the user's own project memory `project_a2_1165_decomposition.md`, which independently documents the same 27-PR `admin.ts` barrel split. Spot-checked: confirmed `apps/web/app/services/admin.ts` is a pure re-export barrel and that `admin-activity.ts`, `admin-treasury.ts`, `admin-write-envelope.ts` etc. exist.)_

- File: `apps/web/AGENTS.md` lines 37-39, vs. actual `apps/web/app/services/` (49 `.ts` files).
- Evidence: doc lists "admin" as if it were a single file; it's actually a barrel re-exporting 33 separate `admin-*.ts` modules. Also entirely missing from the doc: `favorites.ts`, `geo.ts`, `recently-purchased.ts`, `stellar-wallet.ts`.
- Impact: this directory underwent a well-documented, deliberate 27-PR refactor (per the project's own memory notes) specifically to decompose a god-module — and the per-package guide meant to describe the resulting structure still describes the pre-refactor shape.
- Minimal fix: change "admin" to "admin (barrel — see 33 `admin-*.ts` slices)" and add the four missing top-level services.
- Better fix: don't hand-enumerate the 33 admin slices; just describe the barrel pattern and point at `apps/web/app/services/admin.ts`'s own header comment, which (per the decomposition memory note) likely already explains the split.

### DT-11 [P3 · LIVE] Additional minor file-table staleness across `apps/web/AGENTS.md` and `packages/shared/AGENTS.md` (8 sub-items, consolidated)

_(Sub-agent findings; the dead-file reference in (e) was independently re-verified by me — confirmed no `apps/web/app/utils/money.ts` exists anywhere except as a stale `lcov-report` build artifact.)_

- (a) `apps/web/AGENTS.md` line 21: admin components claimed "~40," actual 59 `.tsx` files; top-level component list omits `CountrySelector.tsx`, `FavoritesStrip.tsx`, `FavoriteToggleButton.tsx`, `RecentlyPurchasedStrip.tsx`.
- (b) `apps/web/AGENTS.md` lines 33-34 (`ui/`): 7 primitives listed, 15 actual — missing `Avatar.tsx`, `BackToSite.tsx`, `Badge.tsx`, `Card.tsx`, `Container.tsx`, `LocaleLink.tsx`, `LoopLogo.tsx`, `PageHeader.tsx`.
- (c) `apps/web/AGENTS.md` lines 35-36 (`hooks/`): 6 listed, 12 actual — missing `use-admin-step-up.ts`, `use-app-config.ts`, `use-favorites.ts`, `use-focus-trap.ts`, `use-radio-group-keys.ts`, `use-recently-purchased.ts`.
- (d) `apps/web/AGENTS.md` line 40 (`stores/`): missing `admin-step-up.store.ts` (ADR 028).
- (e) `apps/web/AGENTS.md` lines 45-48 (`utils/`): references a `money.ts` file **that no longer exists** — confirmed only a stale `apps/web/coverage/lcov-report/.../money.ts.html` build artifact remains; `formatMinorCurrency` now comes directly from `@loop/shared`. This is the one item in this group that points at a genuinely deleted file rather than just an undercounted directory. Also missing: `nonce-context.ts`, `redeem-challenge-bar.ts`, `redeem-message.ts`, `sentry-lazy.ts`, `share-image.ts`.
- (f) `apps/web/AGENTS.md` lines 49-51 (`i18n/`): missing `seo.ts`.
- (g) `packages/shared/AGENTS.md` line 25: `users-me.ts` claimed "(13 types)," actual 21 exported interfaces/types (grep-counted) — the file grew (cashback-by-merchant/monthly, payment-method-share, flywheel-stats shapes) without the count being updated.
- Note: `packages/shared/AGENTS.md`'s file-structure table itself (lines 9-43) was spot-checked in full by the sub-agent and found **accurate** — every one of 34 listed files exists, descriptions match actual exports. This is the one of the three per-package guides that is not structurally stale, and is called out here as a positive contrast to (a)-(g) above and to DT-05/DT-08/DT-10.
- Minimal fix: update each count/list per the bullets above; for (e), specifically remove the dead `money.ts` reference and note the `@loop/shared` re-export.
- Better fix: same as DT-05/DT-08's better-fix — regenerate these tables from `find`/`ls` rather than hand-maintaining, since the consistent pattern across both `apps/backend/AGENTS.md` and `apps/web/AGENTS.md` is "every directory that's grown since the doc was last touched is undercounted; directories that haven't grown (e.g. `clustering/`, all of `packages/shared`) remain accurate" — i.e. this is a stale-snapshot problem, not a one-off error pattern.

### DT-12 [P1 · LIVE] `RedeemFlow.test.tsx` never exercises the redemption-WebView open handler — the literal code path that delivers the gift card the user paid for, and a CF-02 security boundary

_(Sub-agent finding (web test-vacuity sweep).)_

- File: `apps/web/app/components/features/purchase/__tests__/RedeemFlow.test.tsx:60-65`, vs. `apps/web/app/components/features/purchase/RedeemFlow.tsx:55-122` (`handleOpenWebView`).
- Evidence: the only test touching the redeem CTA asserts `ctas.length > 0`. `mockOpenWebView` is wired in `beforeEach` but never referenced in any `expect` in the file. `handleOpenWebView` builds the challenge-bar/provider injection scripts, wires `onMessage` → `parseGiftCardMessage` → `store.setComplete`, and handles a popup-blocked error banner plus a timeout→manual-entry fallback — none of it is exercised. Deleting the entire `onClick` handler body would still pass this suite.
- Impact: this is both the user-facing "deliver the purchased gift card" path and the untrusted-`postMessage`-parsing security boundary CF-02 specifically hardened. A regression here (wrong URL, dropped injection script, broken message handler) would ship with green tests.
- Minimal fix: click the CTA, await, assert `mockOpenWebView` was called with the expected `url`/`scripts`; invoke the captured `onMessage` callback with valid and invalid payloads and assert `store.setComplete` is/isn't called accordingly.
- Better fix: also cover the popup-blocked error banner and the timeout→manual-entry fallback (`REDEEM_TIMEOUT_MS`).

### DT-13 [P1 · LIVE] `CreditAdjustmentForm` and `AdminWithdrawalForm` — direct ledger-write components — are never rendered in their own test files; only a pure parsing helper is tested

_(Sub-agent finding (web test-vacuity sweep).)_

- File: `apps/web/app/components/features/admin/__tests__/CreditAdjustmentForm.test.tsx` (49 lines) and `AdminWithdrawalForm.test.tsx` (45 lines), vs. `CreditAdjustmentForm.tsx` (273 lines) and `AdminWithdrawalForm.tsx` (271 lines).
- Evidence: both test files exercise only the exported pure helper (`parseAmountMajor` / `parseUnsignedAmountMajor`). Neither ever renders the actual component — the confirm dialog, the ±100k magnitude-cap check, reason-length validation, the step-up-wrapped mutation, success/error rendering via `formatMinorCurrency`, or idempotency-key generation are all untested at the component level. By contrast, `apps/web/app/routes/__tests__/admin.payouts.$id.test.tsx` _does_ exercise this exact confirm→step-up→retry→idempotency-reuse pattern for payout retry — the test harness for this pattern already exists in the codebase, it's just not applied to these two forms.
- Impact: these are ADR-017/ADR-024 ledger-write surfaces (credit adjustments and admin withdrawals) — among the highest-stakes UI in the app — with effectively no component-level coverage of their actual write path.
- Minimal fix: mirror `admin.payouts.$id.test.tsx`'s pattern for both forms — render, submit, confirm, assert mutation call shape, success/error rendering, and the `STEP_UP_REQUIRED`→retry→same-idempotency-key path.
- Better fix: extract a shared step-up + confirm-dialog test harness, since three call sites (`CreditAdjustmentForm`, `AdminWithdrawalForm`, `admin.payouts.$id`) duplicate the identical interaction pattern and only one of three currently has a test for it.

### DT-14 [P2 · LIVE] `biometrics.ts` and `notifications.ts` native-platform branches have zero test coverage anywhere in the repository

_(Sub-agent finding (web test-vacuity sweep), independently corroborated by me reading `secure-storage-native.test.ts`/`app-lock.native.test.ts` as the positive counter-examples this finding contrasts against.)_

- File: `apps/web/app/native/__tests__/native-modules.test.ts` (728 lines) runs entirely with `Capacitor.isNativePlatform` mocked `false`. Only `app-lock.ts` and `secure-storage.ts` get a dedicated `*.native.test.ts` that flips the flag to `true` and exercises the real native branch (using real in-memory fakes, not mock-call-only assertions — these two are flagged as the **good** pattern to replicate).
- Evidence: `biometrics.ts`'s native branch (the `biometryType` 1/2/3 → fingerprint/face/iris mapping, `deviceIsSecure` passthrough, catch-swallow on plugin error) and `notifications.ts`'s native branch (Android-only gate, `PushNotifications.createChannel` calls) have no test exercising `isNativePlatform() === true` anywhere.
- Impact: these are exactly the code paths that only run on a real device/TestFlight build, never in CI's mocked-web test run — meaning a regression in the biometry-type mapping or the Android notification-channel gate would only surface manually, post-build, on-device.
- Minimal fix: add `biometrics.native.test.ts` mocking `@aparajita/capacitor-biometric-auth`, asserting the type mapping and catch-swallow, following the existing `secure-storage-native.test.ts` template.
- Better fix: same template applied to `notifications.ts`'s native branch; consider a lint/CI check that flags any `native/*.ts` module lacking a matching `*.native.test.ts` sibling, since the two-file pattern (web-fallback test + native test) is clearly the intended convention but isn't enforced.

### DT-15 [P1] Money/auth-critical backend mock-design flaw: a shared chainable Drizzle mock whose `.where()` ignores its predicate arguments, repeated across at least 4 test files, structurally prevents verifying WHERE-clause scoping/safety on security- and ledger-critical writes

_(Sub-agent finding (backend test-vacuity sweep); this is the most consequential single pattern found in this sweep — bundling 4 related instances under one finding since they share one root cause.)_

- Files / evidence:
  - `apps/backend/src/auth/__tests__/refresh-tokens.test.ts:216-223` — `revokeAllRefreshTokensForUser` (the A2-1608 token-theft kill switch) never verifies the update is scoped to `userId`. An unscoped regression (revoke every user's tokens instead of one) would pass.
  - `apps/backend/src/orders/__tests__/transitions.test.ts:83-89` + 5 dependent tests (lines 232, 257, 461, 522, 539) — the order state-machine guard (`eq(orders.state, 'pending_payment')`-style preconditions preventing illegal/duplicate transitions) is structurally unverifiable; a regression deleting the guard entirely would pass the whole suite.
  - `apps/backend/src/auth/__tests__/otps.test.ts:139-167` — `markOtpConsumed`/`incrementOtpAttempts` can't distinguish "operate on the correct row" from "operate on every row."
  - `apps/backend/src/credits/__tests__/liabilities.test.ts:58-65` — self-admittedly (per the test's own comment) only proves a `.where()` call happened, not which currency was filtered.
- Impact: this is not 4 independent bugs but one shared mock-helper design flaw reused across teams/areas. Each instance individually is a real gap on a security- or money-critical write path (mass-logout kill switch, order state machine, OTP consumption, currency-scoped balance query).
- Minimal fix, per instance: capture the `.where()` call's argument(s) in the mock state and assert the expected predicate value(s) appear (e.g. `userId`) — `apps/backend/src/credits/__tests__/withdrawals.test.ts` and `payout-builder.test.ts` (flagged as **Good** in the sample table above) already demonstrate the right pattern (state-tracking inserts/updates with real value assertions) and can be used as the template.
- Better fix: for the order state-machine guard specifically, move to a real-postgres integration test mirroring `apps/backend/src/__tests__/integration/payout-worker.test.ts`'s pattern (which already proves out real concurrent-claim behavior under `LOOP_E2E_DB=1`) rather than trying to make an in-memory mock genuinely predicate-aware — the guard's whole point is a DB-level invariant, which a real DB is the most faithful place to verify.

### DT-16 [P1] `payments/payout-submit.ts`'s `submitNativePayment` — the real-money CTX-forward function with a documented history of stranding paid orders — has zero direct unit test coverage anywhere

_(Sub-agent finding (backend test-vacuity sweep).)_

- File: `apps/backend/src/payments/payout-submit.ts:158-235` (`submitNativePayment`), vs. its only caller's test (`apps/backend/src/orders/__tests__/pay-ctx.test.ts`), which mocks the function away wholesale rather than exercising it.
- Evidence: grep for any test importing `submitNativePayment` directly returns nothing; `payout-submit.test.ts` covers the sibling `submitPayout` function in depth (per the sample table, flagged **Good** — "full Horizon error-classification matrix") but never the native-payment variant.
- Impact: per this project's own memory (`project_principal_switch_pay_ctx.md`), the pay-CTX forwarding step is exactly the kind of function that previously left 4 orders stranded (fulfilled-in-ledger, unpaid-on-CTX) before a fix — meaning this specific function class has a track record of producing exactly the kind of bug that direct unit tests with adversarial Horizon-rejection cases would have caught earlier.
- Minimal fix: add a `submitNativePayment` describe block to `payout-submit.test.ts` mirroring the existing `submitPayout` coverage.
- Better fix: add an adversarial case (Horizon rejects the send) and assert the calling order is not marked paid/fulfilled downstream — i.e., test the actual stranded-order failure mode this function class has already produced once.

### DT-17 [P2] `admin/__tests__/credit-adjustments.test.ts` asserts the literal opposite of production's idempotency-replay behavior — actively wrong as living documentation

_(Sub-agent finding (backend test-vacuity sweep).)_

- File: `apps/backend/src/admin/__tests__/credit-adjustments.test.ts:359-399`, vs. `apps/backend/src/admin/idempotency.ts:197-200` (`withIdempotencyGuard`).
- Evidence: the test "replays a prior snapshot... does not call apply" asserts `body.audit.replayed === false`. Production `withIdempotencyGuard` mutates this to `true` on every genuine replay. The test's hand-rolled mock simply skips that mutation, so the assertion encodes a value that contradicts the real contract. The sibling tests in `withdrawals.test.ts`, `payout-compensation.test.ts`, and `refunds.test.ts` get this right (their replay tests assert `true`), making this one file the outlier.
- Impact: low _functional_ risk (the real behavior is covered correctly elsewhere, in `apps/backend/src/__tests__/integration/admin-writes.test.ts`), but as a piece of documentation-by-test for the ADR-017 replay contract, this test actively teaches the wrong thing to anyone reading it to understand expected behavior — exactly the "false comment/test claim" pattern this sweep was briefed to hunt for, just expressed as a wrong assertion rather than a wrong comment.
- Minimal fix: flip the mock to replicate the real `withIdempotencyGuard` mutation (as the three sibling files already do) and assert `true`.
- Better fix: stop hand-rolling this specific mock behavior per test file; have all four (`credit-adjustments`, `withdrawals`, `payout-compensation`, `refunds`) reuse the real `withIdempotencyGuard` against a mocked DB, the way `apps/backend/src/admin/__tests__/idempotency.test.ts` already does, removing the chance of the four copies drifting out of sync with each other or with production again.

### DT-18 [P2] `credits/__tests__/accrue-interest.test.ts` never reconstructs the A2-610 cross-currency-clobber regression its own implementation header calls out by name

_(Sub-agent finding (backend test-vacuity sweep); independently corroborated by the false-comment-claim check above, which separately flagged `interest-scheduler.ts:9`'s "thorough test coverage" claim about this same suite as overstated.)_

- File: `apps/backend/src/credits/__tests__/accrue-interest.test.ts`, vs. `apps/backend/src/credits/accrue-interest.ts`'s own header comment, which documents the historical A2-610 bug ("UPDATE filtered only by `user_id`, so every currency row got the same balance written back").
- Evidence: every test in the file uses a distinct `userId` per currency under test (e.g. `u-1`/GBP, `u-2`/USD). No test ever gives a single `userId` two currency rows simultaneously — the exact shape that triggered A2-610 — so a regression of that specific historical bug class would not be caught by this suite despite the module existing specifically to fix it.
- Impact: violates the audit checklist's own "regression test for every fixed bug" standard (Part 1 §12) for a money-correctness bug class with a real production history.
- Minimal fix: add one test seeding a single `userId` with both a GBP and a USD `user_credits` row, run `accrueOnePeriod`, and assert both currencies' balances update independently (correct amounts, not the same value cross-applied).
- Better fix: same regression case, but written as the documented basis for `interest-scheduler.test.ts:7`'s "covered by `accrue-interest.test.ts`" claim too, so that comment becomes fully true rather than partially true once this lands.

### DT-19 [P3 · LIVE] Local `npm test` / pre-push has no coverage floor at all; only CI's required `Unit tests` job enforces `vitest`'s `coverage.thresholds`, and the web floor is loose enough to permit the DT-13/DT-14 gaps to persist indefinitely without tripping it

_(Confirmed independently by me directly reading `verify.sh`/`ci.yml`/both `vitest.config.ts` files, and cross-checked against both sub-agents' independent answers to the same question — all three converge on identical numbers.)_

- File: `scripts/verify.sh:19` (`npm test`, no `--coverage`); `package.json:19`, `apps/backend/package.json:10`, `apps/web/package.json:12` (`"test": "vitest run"`, no coverage flag); `.husky/pre-push` (calls `verify.sh`, so the pre-push gate inherits the same no-floor behavior); `.github/workflows/ci.yml:144-145,176-184` (job `test-unit`, `name: Unit tests`, step "Run tests with coverage" → `npm run test:coverage --workspaces --if-present`, no `continue-on-error`); `apps/backend/vitest.config.ts:28-33` (thresholds `lines: 80, functions: 75, branches: 72, statements: 80`); `apps/web/vitest.config.ts:48-53` (thresholds `lines: 37, functions: 40, branches: 32, statements: 35`).
- Verified via `gh api repos/LoopDevs/Loop/branches/main/protection`: `"Unit tests"` is one of the five required-to-merge status-check contexts, and the coverage-threshold step has no `continue-on-error`, so a threshold miss genuinely fails the required check — this is real enforcement, not theater, at the CI layer.
- Impact: this is not a security gap (CI's gate is real), but it is a genuine asymmetry: a contributor's local `npm test`/pre-push run can pass while silently shrinking coverage, and the failure is only discovered after pushing, at PR time. More importantly, the web-package floor (37/40/32/35%) is set generously below the actual measured baseline noted in the config's own comment (~40.2/37.9/45.4/41.1 at time of writing) specifically to "tolerate minor fluctuation" — which means structural gaps like DT-13 (two entire ledger-write form components effectively untested) and DT-14 (two entire native-platform code branches untested) can sit comfortably within that floor indefinitely without ever tripping the gate that's supposed to catch coverage regressions.
- Minimal fix: add `--coverage` to the local `npm test` script (or a separate `npm run verify` step) so `scripts/verify.sh`/pre-push catches threshold regressions before push, matching CI.
- Better fix: periodically ratchet the threshold floors up toward the measured baseline (the config comments already say this is the intended practice — "the explicit goal is to ratchet these up... never to widen the gap between measured and claimed coverage") as a recurring maintenance task, not just a one-time baseline-minus-a-few-points snapshot; consider also tracking per-directory coverage (e.g. a stricter floor for `components/features/admin/**` and `app/native/**` specifically) so a high-stakes area can't hide behind an aggregate average pulled up by well-tested, low-stakes files elsewhere in the same package.

---

## Coverage confirmation

**Positive / clean results (independently verified, not filed as findings):**

- `env.ts` ⇄ `.env.example`: perfect 86/86 parity, confirmed via an extraction pipeline built and re-verified from scratch (catching and fixing a BSD-`sed`-`\s`-portability bug in my own first attempt before trusting any numbers — see Methodology note below).
- `development.md` and `deployment.md`: full 86/86 parity with `env.ts` (one var mentioned only in prose rather than a dedicated table row in both docs — cosmetic, not counted as a gap).
- `scripts/lint-docs.sh` was actually executed end-to-end (not just read) — passes cleanly, 0 errors, across all 10 of its check categories (env-var⇄`.env.example`, route⇄architecture.md parity, stale-file references, stale-domain references, shared-index exports, hardcoded-secret scan, removed-credential scan, critical-file existence, OpenAPI route-registration drift, Capacitor plugin-set parity).
- CF-33's digit-blind-regex fix is **genuinely complete, not just patched for the one reported case**: independently re-ran the fixed pattern (`[A-Z][A-Z0-9_]*`) against the real `env.ts` using the actual macOS BSD `grep`/`sed` binaries (`/usr/bin/grep`, not just the sandbox's `ugrep` shell alias) and confirmed all 86 vars — including every digit-bearing one (`LOOP_PHASE_1_ONLY`, `MAXMIND_GEOLITE2_PATH`) — extract correctly. Grepped all of `scripts/` for any remaining `[A-Z_]+`/`[A-Z_]*` (the old digit-blind shape) — none found outside the explanatory comment describing the historical bug.
- Dead-link sweep: 0 genuine broken links across 856 local-file links checked in 329 markdown files.
- TODO/FIXME hygiene: 0 violations — every TODO/FIXME in `apps/backend/src`, `apps/web/app`, `packages/shared/src` carries a ticket reference.
- Superseded-doc banners (`codebase-audit.md`, `audit-checklist.md`, `audit-tracker.md`, `audit-2026-tracker.md`) all carry accurate, working forward-pointing banners.
- ADR 036/037: confirmed still absent from `docs/adr/` on `main` — consistent with this round's checklist's own expectation; not re-filed (already extensively tracked in `docs/audit-2026-06-15-cold/raw/{v-credits,x-flows-completeness}.md` and this round's `docs/audit-2026-06-30-cold/raw/v-admin-writes.md`).
- Node version (22): consistent across all 9 `node-version` lines in CI workflows, all 3 packages' `engines.node` fields, and both Dockerfiles' pinned base-image digest.
- Root `AGENTS.md`'s rate-limit quick-reference table: every listed route/limit pair spot-checked against the actual `rateLimit(...)` call sites across `apps/backend/src/routes/**` (138 total registrations extracted) — all accurate.
- All `AGENTS.md` "Quick commands" and operator scripts exist and resolve to real `package.json` scripts / files.
- Surface-inventory numbers in this round's `checklist.md` spot-checked accurate: 28 runbooks (exact match), ~378 test files (374 in `__tests__/` dirs + 3 co-located in `packages/shared/src/` = 377, within rounding of the claimed 378).
- Doc-update-rule compliance spot-check on two recent commits: CF-19 (`5296ceef`, ADR 035 extended markets) updated `AGENTS.md`, `docs/architecture.md`, `docs/error-codes.md`, `docs/adr/035-*.md`, and `packages/shared/AGENTS.md` in the same PR — full compliance. CF-30 (`ddae90a7`, native-auth admin grant) updated `.env.example`/`development.md`/`deployment.md` but not `AGENTS.md` — this is the direct evidence behind DT-01.
- `packages/shared/AGENTS.md`: confirmed **not** stale — all 34 listed files exist, descriptions match actual exports, "no runtime deps except `@bufbuild/protobuf`" claim confirmed against `package.json`. Positive contrast to the backend/web per-package guides (DT-05, DT-08, DT-10, DT-11).
- Backend "covered by X" / "tested in X" comment-claim sample: 10 of 11 backend claims independently verified TRUE, 1 partially true (folded into DT-18); web has zero such comments to check (confirmed the grep mechanics work by testing against backend first, ruling out a silently-broken pattern).
- Already-known findings independently re-confirmed as still true (not re-filed): PLAT-30-07 (`ADMIN_EMAILS` missing from `AGENTS.md` — confirmed, shown to be 1 of 49 instances, see DT-01); PLAT-30-04 (`env.test.ts` missing the 4 new vars' boot-validator coverage — confirmed, `grep` for all 4 var names against `env.test.ts` returns nothing); CF-11's step-up-handler test gap (confirmed via the false-comment-claim check on `admin-writes.test.ts:89` — the "covered by unit tests" claim refers to the token-signing primitive and the gate middleware, not the actual `POST /api/admin/step-up` handler, which has no dedicated test file anywhere in `admin/__tests__/`).
- Genuinely strong, non-vacuous backend test files independently confirmed by direct read (beyond the sub-agent's own sample): `credits/__tests__/ledger-invariant.test.ts` (multi-currency, bigint-precision-past-2^53, negative-total edge cases, deterministic ordering), `credits/__tests__/withdrawals.test.ts` (real in-memory DB-chain fake, exact balance/currency assertions, 8 distinct attacker/edge scenarios including duplicate-key idempotency and unrelated-pg-error passthrough), `admin/__tests__/credit-adjustments.test.ts` (real status-code + error-class-to-HTTP-code mapping checks), `auth/__tests__/require-admin.test.ts` (explicitly verifies the documented 404-not-403 admin-masking behavior).

**Methodology note (process transparency):** my first env-var-matrix extraction pass used `sed -E 's/^#?\s*.../'` patterns that silently produced _zero_ substitutions under this sandbox's BSD `sed` (which doesn't support `\s` in `-E` mode, unlike the `grep` shell alias active in this environment, which does). This initially produced a false "AGENTS.md is missing nearly everything, including `NODE_ENV`/`PORT`" result. Caught via a sanity check (`echo "X=" | sed -E 's/.../'` returning the input unchanged instead of a transformed value) before any number was reported, and the entire extraction was redone with `[[:space:]]`-based POSIX patterns and cross-validated against three independent extraction methods (shell-style `VAR=`, backtick-wrapped `` `VAR` `` table-row style, and a manual `grep -c` spot count) before the final 86-row matrix above was built. Flagging this prominently because it's exactly the class of tooling bug (`scripts/lint-docs.sh`'s CF-33 fix) this sweep was asked to re-verify in other people's code — worth being equally suspicious of one's own.
