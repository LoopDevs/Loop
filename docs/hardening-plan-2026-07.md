# Hardening Plan — 2026-07 (Fable pass)

> Task list from an independent cold read of the codebase (2026-07-02): four
> parallel source-only reviews of the money paths, auth/access control,
> verification infrastructure, and overall repo shape — deliberately not
> grounded in prior audit trackers. Goal: fix the judgment-dense residuals,
> make the repo mechanically self-defending, delete structural drift-tax, and
> codify the rest as skills so mid-tier models/engineers can't take the
> project off the rails.
>
> Execution notes: all changes via PR (never push main). Money/auth/Stellar
> diffs get an adversarial-review subagent pass before the PR opens, per the
> review discipline this plan itself codifies in E3. Tracks are independent;
> items within a track are roughly dependency-ordered. `[D]` = needs an
> operator decision before/while implementing (sensible default proposed
> inline — will implement the default unless overridden).
>
> **Status (2026-07-03).** Every high-severity money/auth item and the whole
> mechanical-enforcement + knowledge/skills layer is DONE and merged
> (A1–A5, A7–A8, B1–B4, B6–B7, all of C's gates, all of E). Three
> adversarial-review passes caught real bugs pre-merge — a P0 fund-loss in
> A5, a P0 at-most-once alert in A2/A3, a P0 fleet-stall in A8 — each fixed
> before merge. What remains (marked **[deferred]** / **[blocked]** below) is
> the tail: one operator action I can't take (C9), two structural refactors
> scoped as "days, needs its own dedicated effort — not safe to half-ship"
> (D1–D3), and a few lower-value or `[D]`-blocked items (A6, B5, C3, C10a).
> Each carries its reason inline; none is a money-integrity gap.

## Track A — Money-invariant fixes (the judgment-dense residuals)

- [x] **A1. Emission conservation accounting.** `applyAdminEmission`
      (`credits/emissions.ts:111`) only checks `balance >= amount` per call and
      never decrements anything — repeated emissions can materialize on-chain
      LOOP far beyond the user's mirror liability (cashback fulfillment also
      emits against the same liability). Add cumulative
      emitted-on-chain-per-(user,asset) accounting checked under the same lock,
      plus a daily value cap consistent with the adjustment/refund/compensation
      caps (emissions currently have none). Defense in depth: a DB-level fence
      (accounting table or constraint), not just app logic. _Done:
      `emittedNetMinorFor` conservation check under the existing row lock
      (invariant: mintedNet ≤ mirror balance, where mintedNet = non-failed
      cashback/emission/interest payouts − burns, excluding compensated +
      legacy at-send-debited rows); new 409
      `EMISSION_EXCEEDS_UNEMITTED_BALANCE`; fleet-wide per-currency daily
      cap (advisory-lock serialised, parity with adjustment/compensation
      caps); DB trigger fence in migration 0044 (see C10)._
- [x] **A2. Failed-mint/emission blind spots.** A terminal `failed`
      `interest_mint` leaves the mirror permanently ahead of chain and nothing
      fires: auto-compensation skips non-emission kinds
      (`payout-worker-pay-one.ts:476`), the stuck-payout watchdog excludes
      `failed` (`admin/stuck-payouts.ts:16`), and the drift watcher counts
      failed rows as in-circulation (`pending-payouts.ts:106`). Fix all three:
      failed mints alert + surface in the watchdog, drift equation stops
      counting them as circulating, and define compensation policy (default:
      auto-reverse the mirror credit with an auditable `adjustment`, alert).
      _Done (design refined during implementation): failed burn/mint rows
      STAY inside the drift equation (removing them would page a false
      drift incident — the tokens/credits genuinely exist) but become a
      second persisted, transition-paged state dimension
      (`notifyDriftFailedRows` / `...Cleared`), surfaced on the admin
      drift card + state endpoint. Compensation policy decided:
      retry-first via the existing admin payout-retry, NO auto-reversal
      of user-visible interest — the persistent alert is the guarantee
      ops acts. Stuck-payouts watchdog semantics left unchanged (its
      failed-row exclusion is coherent; the drift dimension is the
      persistent surface)._
- [x] **A3. Persist drift-watcher state.** `asset-drift-watcher.ts:77` keeps
      per-asset state in memory — lost on restart, wrong per-machine. Move to a
      DB table (cursor + last-alert dedup) so the primary unbacked-mint backstop
      survives restarts and is fleet-consistent. _Done: `asset_drift_state`
      table (migration 0043) + `asset-drift-state-repo.ts`; transitions
      claim under `SELECT ... FOR UPDATE` so exactly one machine pages
      per flip; restarts no longer re-page ongoing incidents._
- [x] **A4. pay-ctx settlement idempotency + durable record.** The operator→CTX
      payment (`pay-ctx.ts`) has no persisted tx-hash (never wires `onSigned`)
      and no DB record that Loop paid CTX — idempotency rests entirely on a
      bounded Horizon memo scan of a busy shared account. Persist the
      deterministic hash before submit (same CF-18 pattern as
      `payout-submit.ts:316`) and record the settlement spend in a table.
      _Done: `ctx_settlements` table (migration 0045, one row per order) +
      `orders/ctx-settlements.ts`; payCtxOrder now converges via the
      authoritative hash point-lookup first (window-immune), keeps the
      memo scan as a fallback that backfills the record, pins the intent
      (destination/memo/amount) against URI rotation, and persists the
      signed hash via onSigned before every network submit._
- [x] **A5. Procurement crash-sweep refund policy.** `sweepStuckProcurement`
      (`transitions-sweeps.ts:57`) flips `procuring → failed` with no refund —
      the one failure path that strands a paid user. Disambiguate via CTX using
      the order-id idempotency key (did CTX mint?): if no CTX order exists,
      auto-refund like every other failure path; if ambiguous, alert loudly and
      hold. `[D]` default as stated. _Done — disambiguation uses the A4
      `ctx_settlements` record (did LOOP PAY CTX?) instead of a live CTX
      query: cleaner signal, no external call, no new failure mode. No
      confirmed settlement → Loop never forwarded value → auto-refund (the
      common crashed-worker case). Confirmed settlement → hold + page for
      manual reconcile (a usable card may exist). Settlement-read failure
      fails closed to hold (never auto-refund on uncertainty)._
- [ ] **A6. Late-deposit-after-expiry handling.** _[deferred]_ Deposits landing
      just after `pending_payment → expired` are classified `order_gone` and
      abandoned (`skipped-payments.ts:233`). Already surfaced today — the
      abandon path fires `notifyDepositSkipAbandoned` (attributed RED Discord
      alert: payment / order / reason), so the deposit is NOT silently lost.
      What remains is the `[D]` "refund to sender" automation — an outbound
      payment from the pool to an arbitrary sender address is a new
      money-movement surface that needs an explicit operator OK. Deferred
      pending that decision; the manual-reconcile path works today.
- [x] **A7. loop_asset overpayment.** `amount-sufficient.ts:88` accepts
      `received >= required` but `markOrderPaid` debits/burns only
      `chargeMinor` — excess LOOP sits stranded, un-burned, counted as
      circulating drift. Default: burn/debit the full received amount and
      credit the excess back to the user's mirror (auditable), or refuse
      overpays outright. `[D]` pick one; implementing full-burn-and-credit
      unless overridden. _Done (scope revised on implementation): the order
      still FULFILS (the user paid enough — refusing would strand their
      funds AND deny the order), and a material overpayment (>dust) now
      fires an ATTRIBUTED alert (`notifyLoopAssetOverpayment`: order / user
      / excess stroops) so ops returns the excess directly — vs the drift
      watcher's aggregate signal. Chose this over auto-crediting the excess
      to the mirror: crediting without an on-chain return would itself
      create drift (excess sits at the deposit, not the user's wallet), and
      the correct auto-return (plumb received amount → return payout →
      drift-equation update) is a larger money-movement change than
      warranted for a rare edge the app never triggers (redeem sends exact).
      Follow-up: auto-return-of-excess payout._
- [x] **A8. Single-payout-submitter enforcement.** `SKIP LOCKED` batching
      doesn't stop two Fly machines from claiming disjoint batches and racing
      the shared operator sequence (`tx_bad_seq` → attempt-budget burn →
      legitimate payouts terminally fail). Add a Postgres advisory-lock leader
      gate around the payout tick (cheap, no infra), and same treatment for the
      per-machine CTX rate-limit backoff if trivial. _Done: `withAdvisoryLock`
      (reserved-connection session lock, pooler-guarded) wraps the whole
      payout tick — one machine drains at a time; losers skip. Adversarial
      review caught that a lock held across unbounded Stellar I/O by a hung
      leader would stall the whole fleet (worse than the per-machine race
      it fixes) → added a 90s lease deadline that releases the lock and
      degrades to the accepted pre-A8 posture rather than stalling. CTX
      backoff left per-machine (not trivial; lower value)._

## Track B — Auth hardening

- [x] **B1. Step-up structural enforcement.** `requireAdminStepUp` returns an
      anonymous closure the route-inventory test can't see — a new money-write
      route without step-up passes every structural test. Name the middleware
      (same `Object.defineProperty` trick as `requireStaff`) and extend
      `staff-route-gating.test.ts` to pin the destructive route set to a
      required step-up scope. _Done: middleware named
      `requireAdminStepUp(<scope>)`; inventory test pins the 8 scoped
      destructive routes AND adds a default-deny rule — any new
      admin-tier write must declare step-up or join an explicit,
      reasoned exempt list._
- [x] **B2. Step-up subject-pinning fail-closed.** The `sub === auth.userId`
      check silently no-ops when `auth` is undefined
      (`admin-step-up-middleware.ts:119`) — safe only by mount order today.
      Reject outright when there's no auth context. _Done: missing auth
      context (or missing userId) → 401 + error log; subject check now
      unconditional._
- [x] **B3. Boot cross-field checks.** `env.ts` has many production tripwires
      but none for: `LOOP_AUTH_NATIVE_ENABLED` without a signing key (500s at
      request time), or production admin surface without
      `LOOP_ADMIN_STEP_UP_SIGNING_KEY` (silent 503 on all destructive writes).
      Fail at boot instead. _Done: native-auth-without-key fails parse in
      every env; production-without-step-up-key fails boot unless
      `DISABLE_ADMIN_STEP_UP_ENFORCEMENT=1`; preflight-tranche-1
      promotes the key to REQUIRED. ⚠️ Operator: production Fly
      (`loopfinance-api`) does NOT currently have
      `LOOP_ADMIN_STEP_UP_SIGNING_KEY` — set it before the next deploy
      (`flyctl secrets set LOOP_ADMIN_STEP_UP_SIGNING_KEY=$(openssl rand -base64 48) -a loopfinance-api`;
      note this restarts the app and enables the step-up-gated admin
      writes)._
- [x] **B4. Session revocation surface.** `revokeAllRefreshTokensForUser`
      exists but no route mounts it — no user "sign out all devices," no admin
      "revoke user's sessions," so a stolen 30-day refresh token can only die
      via the reuse heuristic. Mount `DELETE /api/auth/session/all` (self) and
      an admin revoke endpoint (support-tier: fits ADR 037's
      delivery-unsticking remit? — no: it's security-relevant; admin-tier).
      _Done: `DELETE /api/auth/session/all` (self; loop-native revokes all
      refresh tokens, ctx no-ops) + `POST /api/admin/users/:userId/revoke-sessions`
      (admin-tier, step-up-exempt — reversible, no value movement) +
      `signOutAllDevices` web service + a "Sign out everywhere" section on
      /settings/privacy. Access tokens stay non-revocable by design (15-min
      TTL) — see threat-model._
- [ ] **B5. Identity-scoped OTP attempt counter.** _[deferred]_ `otps.ts:135`
      documents its own bump-all-live-rows fix as a stopgap; the correct
      design is a per-email failed-attempt counter decoupled from OTP rows.
      Recorded in `docs/threat-model.md`'s accepted-risk register with its
      current bounds (per-email 3/min issuance + per-IP 10/min) and its
      revisit trigger (any report of OTP guessing). Deferred as a bounded,
      already-mitigated auth refinement (a new counter table) rather than an
      open hole — lower value/risk than the items shipped this pass, and a
      rushed change to the OTP path is exactly the kind of security-critical
      edit that shouldn't be hurried at the tail of a long session.
- [x] **B6. Rate-limit ordering + fallback.** On `/api/admin/*` the blanket
      `requireAuth` + `requireStaff` (two DB reads) run before any per-route
      limiter, so a valid-token non-staff user drives unthrottled DB work; and
      routes without an explicit `rateLimit()` have none. Add a cheap global
      fallback limiter early in the chain; keep per-route budgets as the tight
      bound. _Done: `globalRateLimit` (600/min/IP, `/health`-exempt) mounted
      before all route/namespace middleware — backstops unlimited routes +
      the admin auth-DB-reads path; per-route limiters unchanged as the tight
      bound; distinct `__global__` key namespace._
- [x] **B7. HS256 retirement tripwire.** Nothing ever prompts removing
      `LOOP_JWT_SIGNING_KEY` after RS256 cutover — a standing
      forgery-if-leaked surface. Boot warn (then scheduled alert) when both
      keys are set longer than the 30-day refresh window; wire into the
      dead-flag detector (C5). _Done: boot warn on every deploy while
      both key families are set (deploys are the natural reminder
      cadence; no persisted cutover timestamp needed)._

## Track C — Mechanical enforcement (self-defending repo)

- [x] **C1. Scheduled ledger reconciliation.** `check-ledger-invariant.ts` is
      written but runs nowhere. Nightly workflow (pattern already exists in
      `audit-cron.yml`) against prod/replica: ledger invariant + the on-chain
      drift equation, Discord alert on any drift. The single highest-value
      money-integrity gate per effort. _Done — implemented as an IN-APP
      worker instead of a CI cron (runs where the DB is: no tunnels, no
      new secrets, Discord plumbing shared): `ledger-invariant-watcher.ts`,
      daily default (`LOOP_LEDGER_INVARIANT_INTERVAL_HOURS`),
      advisory-lock single-flight across machines, re-pages every tick
      while drift persists (deliberately no dedup). The on-chain half of
      reconciliation was already continuous via the asset-drift watcher
      (every 300s, hardened in A2/A3)._
- [x] **C2. Web-route auth inventory test.** Web analogue of
      `staff-route-gating.test.ts`: every route module rendering authed data
      must carry the auth/redirect guard. Closes the softest spot in the stack
      (web loaders are excluded from coverage entirely). _Done: shipped in
      #1495 as `route-auth-inventory.test.ts` (checkbox was stale)._
- [ ] **C3. Web coverage floor.** _[deferred]_ Stop excluding `app/routes/**`
      from `apps/web/vitest.config.ts`; add loader/action tests; raise the
      floors. The SECURITY-relevant half — every admin route renders its
      staff gate, every authed surface handles signed-out — is already closed
      structurally by C2's `route-auth-inventory.test.ts`. What remains is
      mechanical coverage-raising (tests for dozens of route loaders):
      tedious volume, not a correctness gap. Deferred as low value/effort.
- [x] **C4. `packages/shared` tests in CI.** No `test`/`test:coverage` script
      → `--if-present` skips it → its money-format/slug/grouping tests are
      dead in CI. One-line fix + verify.sh inclusion. _Done: vitest wired
      (scripts + config + root `test`), and full-package coverage
      measurement exposed 13 untested executable modules — all now tested
      (50 → 118 tests), thresholds ratcheted to 95/88/92/95._
- [x] **C5. Dead-flag detector.** Script asserting every `LOOP_*` flag in
      `env.ts` still gates ≥1 live branch; flags stale flags and (B7) stale
      rotation keys. Wire into verify + CI quality job. _Done:
      `scripts/check-dead-flags.mjs` (all declared env vars, not just
      LOOP_\*) in verify + CI quality. First run immediately found
      ADM-01's `ADMIN_DAILY_WITHDRAWAL_CAP_MINOR` orphaned by the ADR 036
      withdrawal→emission re-scope — revived as the emission cap in
      #1494 — plus the deliberately code-unread operator-secret rotation
      slot (allowlisted with reason).\_
- [x] **C6. Rate-limit presence inventory.** Route-walk test: every mounted
      route declares a limiter or sits on an explicit allowlist (ratcheting,
      like the parity gates). _Done: `rateLimit` middleware named,
      `rate-limit-route-inventory.test.ts` default-deny walk + reasoned
      allowlist (health probe, bearer-gated ops probes, test-only
      endpoints) + stale-entry guard._
- [x] **C7. Integration-suite ledger assertion.** After every flywheel walk,
      assert `sum(credit_transactions) == user_credits.balance_minor` per
      (user,currency) — makes any new mirror-desyncing writer fail CI.
      _Done: `afterEach` ledger-consistency assertion (via
      `computeLedgerDriftSql`) on every test in `flywheel.test.ts` and
      `admin-writes.test.ts`._
- [x] **C8. Property-test seed rotation.** Per-run random seed, logged on
      failure for reproduction (or adopt fast-check) — the current fixed
      `0x5eed_1710` never explores new input space. _Done: time-derived
      seed per run, `PROPERTY_TEST_SEED=<n>` pins an exact replay, and an
      afterEach hook prints the replay instruction whenever a property
      test fails._
- [ ] **C9. Branch-protection verification.** Confirm via
      `gh api .../branches/main/protection` that flywheel-integration,
      migration-parity, and e2e-mocked are actually required checks, not
      advisory; fix the required-check set if not. Zero code, highest leverage.
      _Verified 2026-07-02: the gap is real — "Flywheel integration (real
      postgres)" (which includes migration-parity) is NOT in the required
      set; e2e-mocked is. Adding it is a governance change the permission
      layer reserves for the operator. Run:_
      `gh api -X POST repos/LoopDevs/Loop/branches/main/protection/required_status_checks/contexts --input - <<< '["Flywheel integration (real postgres)"]'`
- [x] **C10a. Apply the A3 pattern to `interest-pool-watcher.ts`.** Found
      during A2/A3 review: the interest-pool low-cover watcher kept its
      transition dedup in a process-memory Set (restart re-pages, each
      machine pages independently — and, the real bug, the machine computing
      "recovered" usually wasn't the one that paged "low", so its empty Set
      silently DROPPED the close). _Done: `interest_pool_alert_state` table
      (migration 0046) + `interest-pool-alert-state-repo.ts` — the full A3
      pattern (durable + fleet-consistent, `SELECT ... FOR UPDATE` transition
      claim, `page_attempt_at` lease, at-least-once delivery via
      `last_paged_state` advancing only after the webhook confirms). The two
      notifiers became pure senders returning the delivery promise (their
      per-process Set was the source of the dropped-recovery bug). Real-pg
      integration + unit tests cover re-page suppression, cross-machine
      recovery, failed-delivery retry, lease, and staleness fence._
- [x] **C10. Emission/mint DB fences.** The DB-level half of A1 — cumulative
      emission accounting constraint/table so no future app-layer writer can
      reopen the unbacked path (same defense-in-depth pattern as the
      interest-mint GBPLOOP pin). _Done: `assert_emission_conservation()`
      BEFORE INSERT trigger (migration 0044, parity-allowlisted like the
      ADR-011 audit triggers) — enforces the same mintedNet ≤ balance rule
      against ANY writer, incl. raw SQL; integration test proves the
      bypass path is rejected._

## Track D — Structural simplification (delete the drift-tax)

- [ ] **D1. Derive OpenAPI from handler Zod schemas.** _[deferred — large,
      needs its own effort]_ The single biggest ceiling-raiser, but the
      repo-shape review scoped it as "design the derivation pattern, migrate
      module-by-module, keep the parity gate until the mirror is gone" — a
      multi-day refactor that must NOT be half-shipped (a partially-migrated
      `openapi/` tree is worse than the honest mirror the parity gate keeps
      correct today). Left as the top structural follow-up; `check-openapi-parity`
      keeps the current mirror honest meanwhile. Original note: 74/76 files in
      `openapi/` (12.3k LOC) hand-redefine shapes the handlers already
      validate; the parity gate is a text-analysis stopgap for a drift class
      that shouldn't exist. Design the derivation pattern
      (`@asteasolutions/zod-to-openapi` is already a dependency), migrate
      module-by-module, keep the parity gate until the mirror is gone, then
      retire both. Biggest single ceiling-raiser; the mechanical tail is
      delegable once the pattern is proven on 2-3 modules.
- [ ] **D2. Split the config giants.** _[deferred — large]_ `db/schema.ts` (1,312 lines) and
      `env.ts` (1,057) are merge-conflict magnets; split by domain
      (orders/credits/wallet/admin; env sections) preserving public exports.
- [ ] **D3. Endpoint co-location + scaffold.** _[deferred — large; partly
      mitigated by the E4 `/add-endpoint` skill, which makes the fan-out a
      guided checklist even without the scaffold generator]_ Adding one admin endpoint
      touches ≥5 files (handler, mount, `app.ts`, openapi, web client, maybe
      shared type) — why `app.ts` (194 changes) and `services/admin.ts` (120)
      are the top churn hotspots. Define a per-module registration convention + a scaffold generator so the fan-out is impossible to get wrong.
      Pairs with D1.
- [x] **D4. Legacy order-path retirement plan.** ADR scoping the deletion of
      the CTX-proxy order path (`orders/handler.ts`, `pay-ctx` legacy fork,
      `orders-legacy` flag branch) once loop-native is default — criteria,
      date, and the flag-matrix simplification it buys. Plan now, delete when
      criteria met. _Done: ADR 039 records the 4 retirement criteria
      (native-auth stable ≥30d, zero legacy orders in flight, no client
      pinning the legacy path, native e2e green), exactly what the deletion
      removes, and the flag-matrix simplification it buys. Deletion deferred
      until criteria hold (takeover mid-roll)._

## Track E — Skills + knowledge transfer (keep mid-tier work on rails)

Principle: enforcement over documentation — anything mechanizable became a
gate in Track C; skills are the residue that genuinely needs judgment.

- [x] **E1. `docs/invariants.md`.** The money-invariants document: every
      "must always be true" (mirror = Σ ledger; emission conservation; the
      drift equation on-chain − pool − burns + mints = mirror; paid orders
      always reach a user-whole terminal state; single submitter per operator
      account; …), each with a pointer to WHAT enforces it (CHECK / test /
      cron / nothing-yet). The single doc this repo most lacks; also the
      review anchor for every future money diff. _Done: 12 invariants,
      each with its enforcement tier + "weakest links" ranking; linked
      from AGENTS.md docs index._
- [x] **E2. Threat model doc.** Assets, actors, trust boundaries (upstream
      CTX, Horizon, Privy, admin bearers, step-up), and the accepted-risk
      register — so future contributors can tell "deliberate tradeoff" from
      "gap."
- [x] **E3. Skill: `/review-money-diff`.** The adversarial review procedure
      for ledger/Stellar/auth-touching diffs: check against E1's invariants,
      concurrency probes (what if two of these run?), merge-regression checks
      (did a conflict resolution drop a gate?), fail-open hunts. Encodes what
      CI structurally cannot catch — merge-introduced semantic regressions.
- [x] **E4. Skill: `/add-endpoint`.** The golden path for the 5-file endpoint
      fan-out as an executable recipe (drives D3's scaffold; interim value
      even before D3 lands).
- [x] **E5. Skill: `/merge-stale-stack`.** Discipline for rebasing stale PR
      stacks: real-postgres integration run per merge, adversarial review on
      money diffs, migration renumbering procedure, conflict-resolution
      gate-preservation checklist.
- [x] **E6. Subagent definitions (`.claude/agents/`).** `money-reviewer`
      (adversarial, invariants-anchored), `auth-reviewer`, and
      `release-preflight` — so E3/E7 are one keyword away for any session.
- [x] **E7. Skill: `/release-preflight`.** Launch-readiness sweep: secrets
      preflight, kill-switch drill, reconciliation clean, branch-protection
      check, e2e-real smoke — one command before any production push.
- [x] **E8. Sensitive-path hook.** Harness hook (settings.json) that flags any
      edit under `credits/`, `payments/`, `orders/`, `auth/`, `wallet/`,
      `db/schema*` and injects a reminder to run E3 before opening the PR —
      the mechanical trigger that makes the skill get used.
- [x] **E9. AGENTS.md "how this repo defends itself" section.** One page:
      the gate inventory (what catches what), the invariants doc, the skills,
      and when each is mandatory. The first thing a future mid-tier agent
      reads.
- [x] **E10. ADR backfill.** Any design decision made while executing A–D
      that isn't mechanical gets an ADR in the same PR (existing repo rule —
      restated here so plan execution honors it). _Done: ADR 038
      consolidates the money-path hardening decisions (A1-A5) with
      their rationale — why DB + app for conservation, why at-least-once
      paging, why the settlement-record signal over a live CTX query,
      why the hash not confirmed_at. Individual mechanical fixes are
      documented at their call sites + this plan._

## Suggested execution order

C9 first (zero code, gates everything else) → Track A + B interleaved (each
item lands with its Track-C enforcement twin where one exists: A1+C10, A2/A3+C1,
B1+its inventory test) → remaining C → E1/E2 (written while A/B context is
fresh) → D1–D3 → remaining E. Money/auth PRs need human review per repo policy —
they'll be batched to respect one-at-a-time pacing where diffs overlap.
