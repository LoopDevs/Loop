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

## Track A — Money-invariant fixes (the judgment-dense residuals)

- [ ] **A1. Emission conservation accounting.** `applyAdminEmission`
      (`credits/emissions.ts:111`) only checks `balance >= amount` per call and
      never decrements anything — repeated emissions can materialize on-chain
      LOOP far beyond the user's mirror liability (cashback fulfillment also
      emits against the same liability). Add cumulative
      emitted-on-chain-per-(user,asset) accounting checked under the same lock,
      plus a daily value cap consistent with the adjustment/refund/compensation
      caps (emissions currently have none). Defense in depth: a DB-level fence
      (accounting table or constraint), not just app logic.
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
- [ ] **A4. pay-ctx settlement idempotency + durable record.** The operator→CTX
      payment (`pay-ctx.ts`) has no persisted tx-hash (never wires `onSigned`)
      and no DB record that Loop paid CTX — idempotency rests entirely on a
      bounded Horizon memo scan of a busy shared account. Persist the
      deterministic hash before submit (same CF-18 pattern as
      `payout-submit.ts:316`) and record the settlement spend in a table.
- [ ] **A5. Procurement crash-sweep refund policy.** `sweepStuckProcurement`
      (`transitions-sweeps.ts:57`) flips `procuring → failed` with no refund —
      the one failure path that strands a paid user. Disambiguate via CTX using
      the order-id idempotency key (did CTX mint?): if no CTX order exists,
      auto-refund like every other failure path; if ambiguous, alert loudly and
      hold. `[D]` default as stated.
- [ ] **A6. Late-deposit-after-expiry handling.** Deposits landing just after
      `pending_payment → expired` are classified `order_gone` and abandoned
      (`skipped-payments.ts:233`). Default: durable queue row + alert with an
      admin "match to order / refund to sender" action instead of silent
      Discord-only abandonment. `[D]` refund-to-sender needs an operator OK
      (outbound payment from the pool).
- [ ] **A7. loop_asset overpayment.** `amount-sufficient.ts:88` accepts
      `received >= required` but `markOrderPaid` debits/burns only
      `chargeMinor` — excess LOOP sits stranded, un-burned, counted as
      circulating drift. Default: burn/debit the full received amount and
      credit the excess back to the user's mirror (auditable), or refuse
      overpays outright. `[D]` pick one; implementing full-burn-and-credit
      unless overridden.
- [ ] **A8. Single-payout-submitter enforcement.** `SKIP LOCKED` batching
      doesn't stop two Fly machines from claiming disjoint batches and racing
      the shared operator sequence (`tx_bad_seq` → attempt-budget burn →
      legitimate payouts terminally fail). Add a Postgres advisory-lock leader
      gate around the payout tick (cheap, no infra), and same treatment for the
      per-machine CTX rate-limit backoff if trivial.

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
- [ ] **B4. Session revocation surface.** `revokeAllRefreshTokensForUser`
      exists but no route mounts it — no user "sign out all devices," no admin
      "revoke user's sessions," so a stolen 30-day refresh token can only die
      via the reuse heuristic. Mount `DELETE /api/auth/session/all` (self) and
      an admin revoke endpoint (support-tier: fits ADR 037's
      delivery-unsticking remit? — no: it's security-relevant; admin-tier).
- [ ] **B5. Identity-scoped OTP attempt counter.** `otps.ts:135` documents its
      own bump-all-live-rows fix as a stopgap; the correct design is a
      per-email failed-attempt counter decoupled from OTP rows. Matters
      double because step-up minting reuses the same primitives.
- [ ] **B6. Rate-limit ordering + fallback.** On `/api/admin/*` the blanket
      `requireAuth` + `requireStaff` (two DB reads) run before any per-route
      limiter, so a valid-token non-staff user drives unthrottled DB work; and
      routes without an explicit `rateLimit()` have none. Add a cheap global
      fallback limiter early in the chain; keep per-route budgets as the tight
      bound.
- [ ] **B7. HS256 retirement tripwire.** Nothing ever prompts removing
      `LOOP_JWT_SIGNING_KEY` after RS256 cutover — a standing
      forgery-if-leaked surface. Boot warn (then scheduled alert) when both
      keys are set longer than the 30-day refresh window; wire into the
      dead-flag detector (C5).

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
- [ ] **C2. Web-route auth inventory test.** Web analogue of
      `staff-route-gating.test.ts`: every route module rendering authed data
      must carry the auth/redirect guard. Closes the softest spot in the stack
      (web loaders are excluded from coverage entirely).
- [ ] **C3. Web coverage floor.** Stop excluding `app/routes/**`, `root.tsx`,
      home, onboarding from `apps/web/vitest.config.ts`; add loader/action
      tests; raise the 35%/32% floors to something honest.
- [x] **C4. `packages/shared` tests in CI.** No `test`/`test:coverage` script
      → `--if-present` skips it → its money-format/slug/grouping tests are
      dead in CI. One-line fix + verify.sh inclusion. _Done: vitest wired
      (scripts + config + root `test`), and full-package coverage
      measurement exposed 13 untested executable modules — all now tested
      (50 → 118 tests), thresholds ratcheted to 95/88/92/95._
- [ ] **C5. Dead-flag detector.** Script asserting every `LOOP_*` flag in
      `env.ts` still gates ≥1 live branch; flags stale flags and (B7) stale
      rotation keys. Wire into verify + CI quality job.
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
- [ ] **C8. Property-test seed rotation.** Per-run random seed, logged on
      failure for reproduction (or adopt fast-check) — the current fixed
      `0x5eed_1710` never explores new input space.
- [ ] **C9. Branch-protection verification.** Confirm via
      `gh api .../branches/main/protection` that flywheel-integration,
      migration-parity, and e2e-mocked are actually required checks, not
      advisory; fix the required-check set if not. Zero code, highest leverage.
      _Verified 2026-07-02: the gap is real — "Flywheel integration (real
      postgres)" (which includes migration-parity) is NOT in the required
      set; e2e-mocked is. Adding it is a governance change the permission
      layer reserves for the operator. Run:_
      `gh api -X POST repos/LoopDevs/Loop/branches/main/protection/required_status_checks/contexts --input - <<< '["Flywheel integration (real postgres)"]'`
- [ ] **C10a. Apply the A3 pattern to `interest-pool-watcher.ts`.** Found
      during A2/A3 review: the interest-pool low-cover watcher still keeps
      its transition state in process memory — restart re-pages, each
      machine pages independently. Port it to the same persisted
      `asset_drift_state`-style claim (or generalise the repo).
- [ ] **C10. Emission/mint DB fences.** The DB-level half of A1 — cumulative
      emission accounting constraint/table so no future app-layer writer can
      reopen the unbacked path (same defense-in-depth pattern as the
      interest-mint GBPLOOP pin).

## Track D — Structural simplification (delete the drift-tax)

- [ ] **D1. Derive OpenAPI from handler Zod schemas.** 74/76 files in
      `openapi/` (12.3k LOC) hand-redefine shapes the handlers already
      validate; the parity gate is a text-analysis stopgap for a drift class
      that shouldn't exist. Design the derivation pattern
      (`@asteasolutions/zod-to-openapi` is already a dependency), migrate
      module-by-module, keep the parity gate until the mirror is gone, then
      retire both. Biggest single ceiling-raiser; the mechanical tail is
      delegable once the pattern is proven on 2-3 modules.
- [ ] **D2. Split the config giants.** `db/schema.ts` (1,312 lines) and
      `env.ts` (1,057) are merge-conflict magnets; split by domain
      (orders/credits/wallet/admin; env sections) preserving public exports.
- [ ] **D3. Endpoint co-location + scaffold.** Adding one admin endpoint
      touches ≥5 files (handler, mount, `app.ts`, openapi, web client, maybe
      shared type) — why `app.ts` (194 changes) and `services/admin.ts` (120)
      are the top churn hotspots. Define a per-module registration convention + a scaffold generator so the fan-out is impossible to get wrong.
      Pairs with D1.
- [ ] **D4. Legacy order-path retirement plan.** ADR scoping the deletion of
      the CTX-proxy order path (`orders/handler.ts`, `pay-ctx` legacy fork,
      `orders-legacy` flag branch) once loop-native is default — criteria,
      date, and the flag-matrix simplification it buys. Plan now, delete when
      criteria met.

## Track E — Skills + knowledge transfer (keep mid-tier work on rails)

Principle: enforcement over documentation — anything mechanizable became a
gate in Track C; skills are the residue that genuinely needs judgment.

- [ ] **E1. `docs/invariants.md`.** The money-invariants document: every
      "must always be true" (mirror = Σ ledger; emission conservation; the
      drift equation on-chain − pool − burns + mints = mirror; paid orders
      always reach a user-whole terminal state; single submitter per operator
      account; …), each with a pointer to WHAT enforces it (CHECK / test /
      cron / nothing-yet). The single doc this repo most lacks; also the
      review anchor for every future money diff.
- [ ] **E2. Threat model doc.** Assets, actors, trust boundaries (upstream
      CTX, Horizon, Privy, admin bearers, step-up), and the accepted-risk
      register — so future contributors can tell "deliberate tradeoff" from
      "gap."
- [ ] **E3. Skill: `/review-money-diff`.** The adversarial review procedure
      for ledger/Stellar/auth-touching diffs: check against E1's invariants,
      concurrency probes (what if two of these run?), merge-regression checks
      (did a conflict resolution drop a gate?), fail-open hunts. Encodes what
      CI structurally cannot catch — merge-introduced semantic regressions.
- [ ] **E4. Skill: `/add-endpoint`.** The golden path for the 5-file endpoint
      fan-out as an executable recipe (drives D3's scaffold; interim value
      even before D3 lands).
- [ ] **E5. Skill: `/merge-stale-stack`.** Discipline for rebasing stale PR
      stacks: real-postgres integration run per merge, adversarial review on
      money diffs, migration renumbering procedure, conflict-resolution
      gate-preservation checklist.
- [ ] **E6. Subagent definitions (`.claude/agents/`).** `money-reviewer`
      (adversarial, invariants-anchored), `auth-reviewer`, and
      `release-preflight` — so E3/E7 are one keyword away for any session.
- [ ] **E7. Skill: `/release-preflight`.** Launch-readiness sweep: secrets
      preflight, kill-switch drill, reconciliation clean, branch-protection
      check, e2e-real smoke — one command before any production push.
- [ ] **E8. Sensitive-path hook.** Harness hook (settings.json) that flags any
      edit under `credits/`, `payments/`, `orders/`, `auth/`, `wallet/`,
      `db/schema*` and injects a reminder to run E3 before opening the PR —
      the mechanical trigger that makes the skill get used.
- [ ] **E9. AGENTS.md "how this repo defends itself" section.** One page:
      the gate inventory (what catches what), the invariants doc, the skills,
      and when each is mandatory. The first thing a future mid-tier agent
      reads.
- [ ] **E10. ADR backfill.** Any design decision made while executing A–D
      that isn't mechanical gets an ADR in the same PR (existing repo rule —
      restated here so plan execution honors it).

## Suggested execution order

C9 first (zero code, gates everything else) → Track A + B interleaved (each
item lands with its Track-C enforcement twin where one exists: A1+C10, A2/A3+C1,
B1+its inventory test) → remaining C → E1/E2 (written while A/B context is
fresh) → D1–D3 → remaining E. Money/auth PRs need human review per repo policy —
they'll be batched to respect one-at-a-time pacing where diffs overlap.
