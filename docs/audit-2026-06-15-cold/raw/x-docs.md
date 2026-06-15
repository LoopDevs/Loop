# Cold Audit 2026-06-15 — Cross-cutting Pass: Documentation Integrity / Coverage / Maintainability (checklist §5)

Branch: `fix/stranded-order-hardening` · Scope: all 275 `docs/**.md` + root `AGENTS.md`/`README.md` + 3 per-package `AGENTS.md` + 11 READMEs + 35 ADRs + 24 runbooks + inline-doc claims. Method: grep/diff/ls cross-checks of docs against live code, plus two delegated deep dives (env-var parity matrix; runbook↔notifier coverage).

Severity rubric per checklist Part 5. Docs default to P2/P3; a wrong runbook command or undocumented prod-gating var rises to P1.

---

## Findings

### P1 — wrong/broken runbook commands, undocumented gate, unguarded parity

**D-01 [P1] · Observability/runbooks · `docs/runbooks/usdc-below-floor.md:15,20`** — Two of the runbook's copy-paste commands reference env vars that do not exist:

- Line 15: `curl ".../accounts/$LOOP_STELLAR_OPERATOR_ID"` — there is no `LOOP_STELLAR_OPERATOR_ID` env var (only `LOOP_STELLAR_OPERATOR_SECRET`, `env.ts:383`; the account ID is derived from the secret). The URL resolves to `accounts/` and fails.
- Line 20: `fly secrets list … | grep LOOP_USDC_FLOOR_STROOPS` — the real var is `LOOP_STELLAR_USDC_FLOOR_STROOPS` (`env.ts:374`, `.env.example:271`). The grep matches nothing.
  Impact: an operator paged for USDC-below-floor (a treasury-float incident) runs commands that silently fail. Fix: correct both var names; the repo's own `asset-drift-alert.md` / `payout-failed-alert.md` already use the right "check Horizon for the operator account" pattern.

**D-02 [P1] · Observability/runbooks · `docs/runbooks/stuck-payout.md:36`** — Same bogus `$LOOP_STELLAR_OPERATOR_ID` in the Horizon curl. Same failure mode/fix as D-01.

**D-03 [P1] · Observability/runbooks · missing pages for two live financial alerts** —

- `notifyInterestPoolLow` (`apps/backend/src/payments/interest-pool-watcher.ts:118`, defined `discord/monitoring.ts:255`) — non-obvious "mint the next batch into the pool" procedure, **no runbook**.
- `notifyPegBreakOnFulfillment` (`apps/backend/src/orders/fulfillment.ts:201`, defined `discord/monitoring.ts:318`) — the alert text itself says "Manual compensation needed to restore the 1:1 peg", **no page tells the operator how**.
  Impact: actionable money-integrity alerts with zero remediation guidance. Fix: add `interest-pool-low.md` and `peg-break.md`.

**D-04 [P1] · Config/env · `scripts/lint-docs.sh:18`** — The env-var parity gate's extraction regex `^\s+[A-Z_]+:` excludes any var name containing a digit, so it silently skips `LOOP_PHASE_1_ONLY` (`env.ts:308`) and `MAXMIND_GEOLITE2_PATH` (`env.ts:114`). The advertised `.env.example ↔ env.ts` gate is therefore incomplete — either var could be dropped from `.env.example` and CI stays green, and every future digit-bearing var (`*_V2`, `*_2026`) inherits the hole. Fix: `[A-Z0-9_]+`.

**D-05 [P1] · Config/env · `LOOP_PHASE_1_ONLY` undocumented in human env docs** — The Phase-1 launch gate (hides all Phase-2 cashback/wallet UI, `env.ts:292-308`) appears only in `env.ts` and `.env.example:167`. It is **absent from `docs/development.md`, `docs/deployment.md`, and the `AGENTS.md` env summary**. Compounded by D-04, nothing enforces its documentation. Impact: an operator preparing a launch cannot find the flag in any human-facing doc. Fix: document it in all three; close D-04 so the gate catches it.

> Note on the checklist hint "ADR 030/031 Proposed but built on branches — flag": **not true on this branch.** There is no `apps/backend/src/wallet/` dir and no Privy adapter here; the only "privy" hits are forward-looking JSDoc comments (`auth/signer.ts:5`, `auth/tokens.ts:7`, `webhooks/hmac-verify.ts:5`). ADR 030 (`:3`) and ADR 031 (`:3`) are correctly `Status: Proposed` with explicit "Gate for Accepted" sections. **On `fix/stranded-order-hardening` the Proposed status is accurate** — no finding. (If the wallet branch is merged without flipping these, re-check.)

### P2 — coverage gaps, missing doc in a primary surface

**D-06 [P2] · Config/env · `MAXMIND_GEOLITE2_PATH` missing from `docs/development.md`** — Present in `env.ts:114`, `.env.example:43-45`, `deployment.md:252`, but the dev env-var doc omits it; a dev wiring `/api/public/geo` locally has no dev-doc reference. Unenforced (D-04).

**D-07 [P2] · Observability/runbooks · `notifyDepositSkipRecorded` has no runbook AND is uncatalogued** — Live alert (`apps/backend/src/payments/skipped-payments.ts:114`, title "🟠 Deposit Skipped — needs investigation", defined `discord/monitoring.ts:70`). Its sibling abandonment alert is fully documented (`deposit-skip-abandoned.md`) but the first-touch page is missing. Also drives D-09.

**D-08 [P2] · Observability/runbooks · `notifyPayoutAwaitingTrustline` has no dedicated page** — Live alert (`apps/backend/src/payments/payout-worker-pay-one.ts:102`). The trustline-missing case is buried inside `stuck-payout.md`/`payout-failed-alert.md` without naming the notifier, so the alert title won't grep to a page. Self-heals, so P2; a one-line README pointer closes it.

### P3 — drift nits, stale cross-refs, structural risk

**D-09 [P3] · Observability · `DISCORD_NOTIFIERS` catalog drift + blind test** — `notifyDepositSkipRecorded` and `notifyDepositSkipAbandoned` are exported from `discord/monitoring.ts` but **not re-exported through `discord.ts`** (`discord.ts:21-42`), so they're absent from the admin "all notifiers" catalog (`discord/notifiers-catalog.ts`). The parity test meant to catch this (`admin/__tests__/discord-notifiers.test.ts:64`) only enumerates `discord.ts` exports, so it passes blind. The test's scope is the bug.

**D-10 [P3] · AGENTS middleware stack incomplete vs `app.ts`** — `AGENTS.md` "Backend middleware stack" lists 7 steps (CORS→secure-headers→body-limit→request-id→logger→rate-limit→circuit-breaker). Actual global chain (`apps/backend/src/app.ts:31-103`) is: `sentry` → cors → secure-headers → body-limit → request-id → **request-context** → access-log → **request-counter**. Three global middlewares are undocumented (`sentry`, `requestContextMiddleware`, `requestCounterMiddleware`); and rate-limit/circuit-breaker are **not** global `app.use` — rate-limit is per-route, circuit-breaker is per-upstream-call. Listing them as numbered "applied in order on every request" steps is misleading (the prose does qualify rate-limit as per-route, but the framing conflates two layers). Fix: split the doc into "global stack" vs "per-route / per-upstream" controls; add the 3 missing global middlewares.

**D-11 [P3] · `apps/web/AGENTS.md:9` route count stale** — Claims "34 routes"; there are 39 route `.tsx` files (`apps/web/app/routes/`) / ~49 `route()`+`index()` entries in the authoritative `apps/web/app/routes.ts`. (The checklist itself says "40 web routes".) The admin sub-count "(17 routes)" (`:16`) is roughly right (~17 `admin.*.tsx`).

**D-12 [P3] · `docs/runbooks/README.md:56-60` stale tracker pointer** — Footer tells operators to "reference the gap in `docs/audit-2026-tracker.md`" for alerts lacking a page; `AGENTS.md:21` marks that tracker **superseded** (per its own A4-068 banner). Points operators at a dead tracker. (README runbook index itself is 1:1 complete with on-disk files — verified, no missing/extra entries.)

**D-13 [P3] · `docs/runbooks/payout-permanent-failure.md:8-9` overstates trigger** — Says triggered by "ping from `payout-watchdog`"; the watchdog (`stuck-payout-watchdog.ts`) emits `notifyStuckPayouts` (age-backlog), while the per-row permanent-failure signal is `notifyPayoutFailed`. Wording implies a per-row watchdog ping that doesn't exist.

**D-14 [P3] · `AGENTS.md:21-22` docs-index ADR coverage starts at 005** — The index ADR table lists `005`–`035` but omits `001`–`004` (static-export, TS backend, protobuf, security-hardening). 001/003 are summarized in the "Architecture (one-liner per layer)" prose, but the index table itself is incomplete for the first four ADRs. (The earlier comprehensive-audit-2026-06-11 finding that the index "stops at 031" is **fixed** — it now reaches 035.)

**D-15 [P3] · `scripts/lint-docs.sh` parity is one-directional & doc-incomplete** — Only checks `env.ts → .env.example`; no reverse `.env.example → env.ts` check (a var left in `.env.example` after removal from `env.ts` would never flag — currently clean but unguarded), and it never checks `env.ts → development.md`/`deployment.md` (which is precisely why D-05/D-06 exist unenforced). `scripts/lint-docs.sh:15-22`.

**D-16 [P3] · ADR 036 / ADR 037 referenced but do not exist** — This cold audit's own `checklist.md` (Part 4, Part 2 V4/V8) and sibling raw notes (`raw/v-credits.md`, `raw/v-payments.md`, `raw/v-wallet.md`, `raw/v-admin.md`) cite "ADR 036 (burn/issuer-return)" and "ADR 037 (staff roles)" as governing invariants, but `docs/adr/` only contains 001–035 and there is **no `requireStaff`/`customer_support` code** in `apps/backend/src`. These are planned/unwritten ADRs being treated as existing requirements. Either ADRs must be authored or the references corrected. (Scope note: internal to the audit doc set, not shipped product docs — but it taints the audit's own coverage matrix.)

---

## Things verified CLEAN (no finding)

- **Dead-link sweep** — every relative `.md`/`.sh`/`.ts`/`.toml`/`.json` link across all 275 docs + AGENTS files + 11 READMEs resolves to a real file. Zero dead links.
- **AGENTS Docs-index file existence** — all 16 linked docs/dirs exist (incl. the pre-2026 historical trio).
- **AGENTS quick-commands** — all 15 npm scripts (`verify`, `check:openapi-parity`, `check:migration-parity`, `proto:generate`, etc.) and all 6 operator scripts (`preflight-tranche-1.sh`, `bootstrap-e2e-refresh-token.sh`, `e2e-real.mjs`, …) exist; `mobile:sync`/`build:mobile` resolve.
- **AGENTS rate-limit numbers** — spot-checked `/api/clusters` (60), `/api/image` (300), `request-otp` (5), `POST /api/orders` (10) all match `routes/*.ts` exactly.
- **architecture.md API endpoints** — admin routes use the `mount*` factory pattern with full-path literals (`routes/admin-*.ts`); endpoints documented are real (false-positive "stale" list from path-normalization was disproved). Route↔OpenAPI registration is independently gated by `check:openapi-parity` (in `verify` + CI).
- **`.env.example` ↔ `env.ts`** — all 82 env.ts vars present in `.env.example`; no stale entries; **all default values match** (PORT, LOG_LEVEL, refresh cadences, pool/timeout, payout fee/interval, interest, stellar, email).
- **Prod-required gating consistent** — `IMAGE_PROXY_ALLOWED_HOSTS` (env.ts:696 throw ↔ AGENTS:216 ↔ .env.example:40), `EMAIL_PROVIDER`/`RESEND_API_KEY`, `DATABASE_URL` all consistent across env.ts/.env.example/AGENTS.
- **ADR currency** — 030/031 correctly `Proposed` on this branch (no built code); 033 correctly marked superseded by 034; ADR 015's status line accurately disclaims that USDLOOP→LOOPUSD retirement only applies _once 030/031 are Accepted+shipped_ — live code (`packages/shared/src/loop-asset.ts:49`) still uses USDLOOP/GBPLOOP/EURLOOP, so docs documenting them as live are correct (the prior comprehensive-audit "ADR 015 lies" finding was fixed by commit 9fa466c5).
- **Comprehensive-audit-2026-06-11 doc findings (#9) reconciled** — FIXED on this branch: AGENTS ADR index now reaches 035; CI job count now "twelve" (`AGENTS.md:341`); ADR 028 env var corrected to `LOOP_ADMIN_STEP_UP_SIGNING_KEY` everywhere (matches `env.ts:275`); `operator-pool-exhausted.md` now points at real `ctx/operator-pool.ts`. STILL OPEN (tracked, not a doc lie): CODEOWNERS `@LoopDevs/engineering` team doesn't exist (self-documented A2-103, `.github/CODEOWNERS:3-8` — required-review rules are silent no-ops).
- **No orphan TODOs in docs** — all `TODO` matches are policy statements (standards.md) not orphan markers.
- **Commit format** — last 8 commits all Conventional Commits, matching `standards.md:456`.
- **testing.md** — explicitly disclaims exact test counts (`:19`) rather than asserting a stale number = good hygiene. AGENTS.md no longer claims "84 tests" (only the operator's out-of-scope MEMORY.md does).
- **Runbook README index** — 1:1 with on-disk runbook files; all sibling-runbook cross-links resolve; `alerting.md` references only real notifiers.
- **Backend AGENTS file table** — spot-checked `src/*.ts` references all exist.

---

## Coverage

Surface examined (checklist §5 dimensions):

- **Code↔doc drift** — AGENTS middleware stack (D-10), rate limits (clean), quick-commands (clean), operator scripts (clean); architecture.md endpoints (clean, mount-factory verified); per-package AGENTS route count (D-11); standards.md commit format (clean); testing.md counts (clean/disclaimed).
- **Env-var parity** — full 5-source matrix (env.ts / .env.example / AGENTS / development.md / deployment.md) via delegated agent; 82-var set; D-04/D-05/D-06/D-15.
- **Runbook coverage** — 27 live `notify*` functions × 24 runbooks cross-referenced via delegated agent; D-01/D-02/D-03/D-07/D-08/D-09/D-12/D-13; no dead/orphan runbooks; informational/audit-trail notifiers correctly page-less.
- **Doc-update-rules adherence** — per-path kill switches (PR #1421) fully propagated (AGENTS/deployment/development/runbook/.env.example); redemption-backfill (PR #1419) has runbook + README entry; ADR 028 env-var fix propagated.
- **ADR currency** — all 35 ADR status lines reviewed; 030/031 Proposed (accurate this branch); 033 superseded-marked; 015 supersession framing accurate; D-14 (index 001-004), D-16 (036/037 phantom).
- **Dead links / doc index / audit-trail authority** — full relative-link sweep (clean); doc-index file existence (clean); audit-trail authority (AGENTS designates `audit-2026-05-03-claude/tracker.md` active; comprehensive-audit-2026-06-11 "in execution"; this 06-15 cold audit not yet in index — expected, in progress).
- **Maintainability** — comment honesty (CODEOWNERS/lint-docs self-documenting; no lies found in spot-checks); TODO hygiene (clean).

NOT exhaustively covered (time-boxed, lower ROI given existing gates): full 154-way architecture.md-endpoint × code diff (delegated to `check:openapi-parity` gate); inline-comment honesty across all ~1,030 source files (cross-cutting comment-honesty pass owned elsewhere); the 200+ historical audit-evidence notes under `docs/audit-2026-*/` (frozen artifacts, not live docs).

---

## Summary

16 findings: **5 P1**, **3 P2**, **8 P3**. No P0 (docs don't lose money directly).

The P1s cluster in two places: **runbooks that will fail under a real page** (D-01/D-02 bogus `$LOOP_STELLAR_OPERATOR_ID` + wrong floor-var name in usdc-below-floor/stuck-payout; D-03 two live financial alerts — interest-pool-low, peg-break-on-fulfillment — with no remediation page at all), and **an env-parity gate with a digit-blind regex** (D-04) that lets the Phase-1 launch gate `LOOP_PHASE_1_ONLY` sit undocumented in every human env doc (D-05). The runbook P1s are the most operationally dangerous: they bite exactly when an operator is mid-incident.

Counter-evidence to the checklist's priors worth recording: ADR 030/031 are **correctly** Proposed on this branch (no built code here — the "built on branches, flag it" hint doesn't apply to `fix/stranded-order-hardening`), and the entire comprehensive-audit-2026-06-11 doc-lie cluster (#9) is **largely fixed** here except the long-standing CODEOWNERS no-op (A2-103, tracked). General doc health is strong: zero dead links, command/script/rate-limit/endpoint claims accurate, env defaults perfectly in sync, good count-drift hygiene in testing.md.

Recommended fix order: D-01/D-02/D-03 (runbook commands + missing pages) → D-04/D-05 (lint-docs regex + document the launch gate) → D-06/D-07/D-08/D-09 (env doc + skip-recorded page + notifier catalog) → D-10..D-16 (drift nits).
