# Money / Auth Work List (scoped + prioritized)

> The money- and auth-path work that gates real-money volume, pulled out of the
> 85-item `readiness-backlog-2026-07-03.md` and **sequenced by risk** so the
> highest-stakes correctness work is unambiguous. The backlog remains the source
> of truth for each item's full **Why / Do / Done-when**; this doc adds priority,
> effort, review type, and the workflow. Keep the two in sync (tick both).
>
> **Go-ahead granted 2026-07-09** — items below are now being worked review-first.
>
> **Workflow — review-first.** Every item here touches money, auth, or Stellar,
> which `CLAUDE.md` requires a human to review before merge. So these are worked
> **one at a time as review-ready PRs that are NOT self-merged** — each PR states
> which `docs/invariants.md` invariants it preserves and posts a `money-reviewer`
> / `auth-reviewer` pass. Nothing here is auto-merged.
>
> **Effort:** S ≈ <½ day · M ≈ 1–2 days · L ≈ multi-day / architectural.
> **Review:** 💰 money-review · 🔐 auth-review.

---

## Phase 0 — De-risk before touching money code

- [x] **AUDIT-1 · Verify the GBPLOOP unbacked-mint P0 actually landed.** _S · 💰 · read-only._
      Agent memory flags a GBPLOOP unbacked-mint P0 + CF-08/CF-25 regressions + a
      peg-break bug found during the 2026-07-02 wallet/staff stack rebase. Confirm
      each is fixed in `main` and hasn't regressed (`credits/interest-mint.ts`,
      `credits/payout-asset.ts`, the emission-conservation DB constraint). Output:
      a findings report, no code change.
      **Done 2026-07-07:** read-only regression verification passed for GBPLOOP
      mint allowlisting, issuer-pinned payout assets, DB mint/emission
      constraints, CF-08 step-up scopes, CF-25 redeem encryption/tamper handling,
      and LOOP-asset currency/peg checks; see
      [`audit-2026-07-07-gbploop-regression.md`](./audit-2026-07-07-gbploop-regression.md).
- [x] **Q6-1 · Direct test for `orders/ctx-settlements.ts` (0% counted).** _S–M · 💰._
      Mocked in every unit test today; add real assertions for the ADR-038 durable
      settlement-idempotency logic. Characterizes the code before anyone changes it.
      **Done 2026-07-07:** direct counted unit coverage now pins insert,
      conflict re-read, tx-hash persistence, confirmation, and chain backfill.
- [x] **Q6-2 · Raise coverage on the money/auth workers.** _M · 💰🔐._
      `payout-worker.ts` (42%), `ledger-invariant-watcher.ts` (50%),
      `payout-submit.ts` (61%), `otp-attempt-counter.ts`. Coverage-as-characterization
      — often surfaces bugs on its own.
      **Done 2026-07-07:** added counted unit coverage for
      `auth/otp-attempt-counter.ts` covering lockout reads, atomic failed-attempt
      upsert shape, successful-verify clearing, and stale-counter purge. Focused
      test passes; targeted coverage shows `otp-attempt-counter.ts` at 94.44% lines /
      80% branches. Also expanded `payments/payout-submit.ts` coverage across native
      XLM submits, pre-signed submits, signed-hash fallbacks, and build/persist
      failures; targeted coverage now reports 98.8% lines / 79.16% branches.
      Added lifecycle coverage for `credits/ledger-invariant-watcher.ts` (start
      idempotence, immediate tick success/failure, stop); targeted coverage now
      reports 97.5% lines / 75% branches. Added payout-worker lifecycle/reset
      coverage; targeted `payments/payout-worker.ts` coverage now reports 89.04%
      lines / 76.19% branches.
- [x] **AUDIT-2 · Adversarial money-path sweep.** _M · 💰🔐 · read-only._
      Run the `money-reviewer` / `auth-reviewer` subagents + `/review-money-diff`
      anchored on `docs/invariants.md`, across `credits/` `payments/` `orders/`
      `wallet/` `stellar/`. Catches issues not on this list; feeds new items back here.
      **Done 2026-07-09:** five parallel domain sweeps (credits, payments,
      orders, wallet+stellar, auth) found 5 P1s + several P2s; see
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md).
      Filed as AUDIT-2-A through AUDIT-2-E below.

## Phase 1 — Money correctness (can lose or double-count value)

- [x] **AUDIT-2-B · `loop_asset` payment method has no server-side Phase-1 gate (LIVE-RISK).** _M · 💰._
      ✅ Done 2026-07-09 (#1603).
      No `LOOP_PHASE_1_ONLY` check anywhere in the `loop_asset` create/redeem
      path — `orders/loop-handler.ts` (contrast the `credit` gate at
      ~404-420), `orders/redeem.ts` (gated only on wallet-provider +
      provisioning, never phase), `orders/transitions.ts:73-211` (debit path),
      `credits/emissions.ts:342-347` (admin emission mints on-chain LOOP
      regardless of the flag). `fly.toml` confirms `LOOP_WORKERS_ENABLED=true`
      and `LOOP_PHASE_1_ONLY=true` coexist in production; the only thing
      holding the line today is that no user has a provisioned wallet with a
      nonzero LOOP balance plus the client not rendering the UI — both
      incidental, not structural. Matches
      `docs/readiness-backlog-2026-07-03.md` Tier 12 LIVE-RISK, now scoped
      to four call sites. See
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md) finding B.
      **Done when:** `loop_asset` create + redeem both reject with a clear
      `PHASE_1_ONLY` error while the flag is set, same shape as
      `CREDIT_METHOD_RETIRED`.
- [x] **AUDIT-2-A · USDC deposit matching accepts any-issuer USDC when `LOOP_STELLAR_USDC_ISSUER` is unset.** _S–M · 💰 + operator._
      ✅ Done 2026-07-09 (#1601).
      `payments/watcher.ts:166-170` + `payments/horizon.ts:191-213` (line 211
      is a vacuous-true issuer clause when the issuer arg is `undefined`) +
      `payments/amount-sufficient.ts:99-119` (amount-only, no identity
      re-check). `env.ts:112-129` only warns when the value is _wrong_, says
      nothing when it's _absent_; only the operator-run
      `scripts/preflight-tranche-1.sh:43` actually requires it. Contrast
      `credits/payout-asset.ts:73-84`, which correctly excludes unissued LOOP
      assets with an explicit comment about this exact attack shape.
      Independently found by two reviewers (payments + wallet) — see
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md) finding A.
      **Operator action (blocking, do first):** confirm whether
      `LOOP_STELLAR_USDC_ISSUER` is actually set in production Fly secrets.
      Escalates to P0 if unset. Cross-references `docs/go-live-plan.md` T1-C.
      **Done when:** `env.ts` boot-fails in production when the USDC payment
      method is reachable and the issuer is unset (same pattern as
      `LOOP_ADMIN_STEP_UP_SIGNING_KEY`), and/or defaults to Circle's
      canonical mainnet issuer on mainnet.
- [x] **AUDIT-2-C · Deposit watcher silently drops `no_match`/`no_memo` payments.** _S–M · 💰._
      `payments/watcher.ts:192,207-208,438-441` — the outcome switch
      `break;`s with no `recordSkip` call. Root cause in
      `payments/horizon.ts:199` (`type !== 'payment'` excludes path
      payments — reconfirms the still-open finding in
      `docs/audit-2026-06-30-cold/raw/v-payments.md`) and `:203-204`
      (`memo_type !== 'text'` folded into asset matching — new observation,
      a memo-less or wrong-memo-type direct payment is indistinguishable
      from "wrong asset"). Real value lands at Loop custody, gets no DB row,
      cursor advances past it, order expires in 24h with no recovery trail
      (R3-1 float reconciliation not yet fully production-wired). See
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md) finding C.
      **Done when:** any payment-op with `to === depositAddress` that fails
      every rail match routes into `recordSkip` with a new reason, visible
      on `/admin/skips`.
      ✅ Done 2026-07-09 (#1604, review-first — not yet merged at doc-write
      time). `horizon.ts` now accepts `path_payment_strict_send`/
      `path_payment_strict_receive` (same destination-side field names as
      `payment`) and adds `isInboundDeliveryToAccount` — the exact
      inbound-vs-outbound discriminator (successful payment/path-payment op,
      `to === account`), independent of asset/memo matching. The watcher
      records a new `unrecognized_deposit` skip reason for any inbound
      delivery that fails every rail match (both the live tick and the
      retry-sweep re-evaluation path, so the reason survives retries instead
      of being clobbered to `processing_error`), gated on the same
      `REFUND_MIN_STROOPS` dust floor T0-1c uses. Outbound operator
      payments/payouts (`to !== account`, same shared deposit/operator
      account) are never recorded — verified by dedicated tests. Migration
      0056 widens the reason CHECK; the backend `/api/admin/watcher-skips`
      handlers pick the new reason up automatically (already generic over
      `WATCHER_SKIP_REASONS`) — but `money-reviewer` caught that the web
      admin route (`admin.skips.tsx`) hardcoded its own reason
      filter/dropdown list independent of the shared constant, so the new
      reason (and, pre-existing, `order_gone`) couldn't actually be
      filtered on; fixed in the same PR by deriving from
      `WATCHER_SKIP_REASONS` instead (closes the drift class). A second
      money-review pass caught that alerting on every `unrecognized_deposit`
      row (added to `ALERT_ON_FIRST_RECORD`) was itself a public-deposit-
      address Discord-flood vector — a ~1¢ tx with 100 dust ops could fire
      ~50 pages/tick on the shared monitoring channel and push real pages
      past Discord's rate limit; fixed by routing the reason to a throttled + rolled-up `notifyUnrecognizedDepositRecorded` (leading-edge page,
      one count-bearing page per ~15-min window, mirrors the circuit-breaker
      dedup) while every row is still written to the DB unconditionally.
      **Known residuals** (not blocking): the A6 automated refund path still
      only handles `type === 'payment'` (path-payment skip rows are
      visible/recoverable but not yet one-click-refundable — noted in-code at
      `deposit-refund.ts`); and `account_merge` deliveries stay outside the
      recovery trail (see P2-d below).
- [x] **AUDIT-2-D · `interest-mint.ts` idempotency-skip catch never matches the real error shape.** _S · 💰._
      `credits/interest-mint.ts:324-337` (same pattern in
      `credits/accrue-interest.ts:183-201`, P2/legacy-gated-off) string-matches
      `err.message`, but Drizzle wraps the real Postgres error in a
      `DrizzleQueryError` whose top-level message is a fixed
      `"Failed query: ..."` string — the unique-violation code/constraint
      lives on `err.cause`. `credits/refunds.ts:502-515` and
      `credits/emissions.ts:378-388` already solve this correctly by walking
      `err.cause`. Effect: after a crash/redeploy mid-sweep, re-processing
      already-minted users throws misclassified errors, the cursor never
      advances (`writeMintCursor` gated on `errors===0`), hours of
      error-spam until the period rolls over at midnight UTC. **Not a
      double-mint** — the DB unique constraint forces rollback first, so
      this is a reliability/observability bug, not a money-safety one. The
      existing test mocks a flat `Error`, not the real wrapped shape — false
      confidence. See
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md) finding D.
      **Done when:** a shared `isUniqueViolation(err)` helper walks
      `err.cause` for `code==='23505'`, used in both mint paths, with a test
      that constructs the real wrapped-error shape.
      **Done 2026-07-09:** added `db/errors.ts` (`isUniqueViolation` /
      `isUniqueViolationOnAny`) walking the `.cause` chain for
      `code==='23505'`, optionally pinned to a specific `constraint_name` so
      an unrelated unique violation isn't silently swallowed. Wired into
      `interest-mint.ts` (both the snapshot and credit-transactions fences,
      named explicitly) and `accrue-interest.ts`. Also refactored
      `refunds.ts`'s `isDuplicateRefund` and `emissions.ts`'s
      `isDuplicateEmission` onto the same shared helper (DRY — same
      behavior, tests unchanged). `orders/repo-idempotency.ts`'s
      `isOrderIdempotencyConflict` already used the correct cause-walking
      pattern independently (A4-026) and was left as-is — a trivial
      follow-up would dedupe it onto the shared helper too.
      `admin/payouts-retry.ts`'s `isEmissionConservationViolation` walks
      `.cause` correctly but matches on message text, because it's
      detecting a `RAISE EXCEPTION` (trigger check-violation, no
      `constraint_name`/`23505`) rather than a unique-index violation — a
      structurally different case, confirmed not the same bug, left as-is.
      New tests construct the real `DrizzleQueryError`-wrapped shape
      (fixed outer message, `code`/`constraint_name` on `.cause`) and were
      confirmed to fail against the pre-fix code.
- [x] **T0-1b · Duplicate deposit against an already-PAID order.** _M · 💰._
      Persist the paying deposit's Horizon payment id + tx hash on the order in
      `markOrderPaid` (schema + migration); in the watcher's `unmatched` arm, record
      a _second_ deposit as refundable while the original paying deposit re-read never is.
      **Done when:** dup deposit → recorded + refundable; original paying deposit re-read → never recorded (integration test both ways).
      **Done 2026-07-07:** migration 0050 adds nullable paying-payment id/hash
      columns to `orders`; the watcher stamps them on `markOrderPaid`. A fresh
      unmatched deposit for a paid/procuring/fulfilled order is now recorded as
      `order_gone` only when its Horizon operation id differs from the stored
      paying id. Focused tests cover duplicate recording, original-payment reread
      suppression, and legacy paid orders with no stored paying id.
- [ ] **R3-2 · Auto-refund delivers the wrong asset in Phase-1.** _M · 💰._
      `credits/refunds.ts:118-137` credits mirror LOOP with no `payment_method`
      branch. Branch the refund by `orders.payment_method`: xlm/usdc → on-chain to
      sender (reuse A6 `refundDeposit`/`submitPayout`); loop_asset → mirror. Must
      stay idempotent (don't break the partial-unique guard; don't double-refund vs A5-4).
      **Done when:** each method refunds in the asset it was paid; integration test per method.
      **Partial 2026-07-07:** XLM/USDC failed-order auto-refunds now persist the
      paying Horizon payment snapshot on `orders`, materialize it as an abandoned
      refundable deposit row, and drive A6 `refundDeposit` so the sender receives
      the original on-chain asset/amount. `credit` keeps the mirror refund. The
      `loop_asset` branch now fails closed for manual money review instead of
      issuing a drift-causing mirror-only refund; full R3-2 remains open until
      re-mint/re-credit semantics are implemented and reviewed.
- [x] **R3-9 · Redeem in-flight fence is process-local.** _M · 💰._
      `orders/redeem.ts` `inFlightOrders` Set is per-process → two taps on the
      2-machine fleet both submit. Replace with a durable guard (short-TTL DB row /
      advisory lock / CAS on an in-redemption state); must not deadlock a legit retry.
      **Done when:** two concurrent redeems on different machines → exactly one submission (race test).
      **Done 2026-07-07:** replaced the process-local Set with a fleet-wide
      advisory lock keyed by order id. Lock contention returns the existing
      `PAYMENT_IN_FLIGHT` response; the lock releases after the handler attempt so
      sequential retries still work. Existing concurrent redeem race coverage now
      uses an advisory-lock mock and proves exactly one submit.
- [x] **R3-10 · Make order-create idempotency default-on.** _S–M · 💰._
      `orders/loop-handler.ts:179-201` only dedups when the client sends
      `Idempotency-Key`. Derive a server-side key (or require the header) so a
      double-click can't double-debit a credit-method order.
      **Done 2026-07-07:** no-header `credit` orders derive a short-window server
      fallback key and replay duplicates through the existing order idempotency
      path; regression test proves two identical no-header submits call the
      create/debit path once.
- [x] **R3-5 · Upper-band sanity check on the pay-CTX amount.** _S–M · 💰._
      `procure-one.ts:287-299` → `pay-ctx.ts` pays CTX's own SEP-7 amount with no
      ceiling. Assert it's within a boot-configured band of expected wholesale;
      out-of-band → fail-safe (refund + page) not silent overpay.
      **Done 2026-07-07:** `LOOP_CTX_PAYMENT_MAX_BPS_OF_EXPECTED` defaults to
      125%; an inflated mocked URI marks the order failed, auto-refunds, pages,
      and never calls `payCtxOrder`.
- [x] **T0-1c · Don't record sub-dust `order_gone` deposits.** _S · 💰._
      Self-funded nuisance vector: expire your own order, spam dust to its memo.
      Skip recording deposits below `REFUND_MIN_STROOPS` in the watcher's
      `unmatched`/`order_gone` path (they can't be A6-refunded anyway).
      **Done 2026-07-07:** watcher tests cover sub-dust late deposits being
      counted but not recorded, while deposits at the refund floor still create
      the `order_gone` skip row.
- [ ] **R3-1 · Operator XLM/USDC float reconciliation.** _M · 💰._ See backlog for scope.
      **Partial 2026-07-07:** schema, Horizon movement indexer,
      classifier, single-flight worker, Discord drift/unclassified page,
      Treasury state, unclassified movement drilldown, and audited
      baseline/manual movement admin writes landed.
      **Code-complete 2026-07-10** (review-first, not yet merged at
      doc-write time): cold-start cursor safety promoted from an
      app-layer (Zod-only) check to a DB-enforced NOT NULL + non-empty
      constraint on `operator_wallet_baselines.starting_horizon_cursor`
      / `current_horizon_cursor` (migration 0057) — a baseline with a
      null cursor made the indexer omit Horizon's `cursor` param
      entirely and walk the account's full payment history from
      genesis; with no active baseline at all the watcher already
      failed closed to `needs_baseline` without touching Horizon.
      `needs_baseline` now pages Discord (same at-least-once cadence as
      drift/unclassified) — previously a deployed-but-unconfigured
      watcher sat silent forever with nothing prompting an operator to
      set it up. Thresholds
      (`LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS` /
      `_USDC_THRESHOLD_STROOPS` / `_RECONCILIATION_INTERVAL_HOURS`)
      were already `parseEnv`-validated with safe production defaults;
      this pass adds boot-fail tests and closes the doc gap (AGENTS.md
      / `docs/development.md` / `docs/deployment.md` /
      `apps/backend/.env.example` were all missing these three vars).
      Memo policy documented (the classifier never trusts memo text —
      only authenticated DB linkage — so operator-initiated movements
      always need an explicit manual-movement explanation via
      `POST /api/admin/operator-float/manual-movements`) in the
      new `docs/runbooks/operator-float-drift.md`, which also covers
      `needs_baseline`/`unclassified`/`drift` triage. Confirmed: this
      module makes **no balance-adjusting writes** — classification +
      audit-trail + paging only.
      **👤 Remains open** until an operator creates the real production
      baseline (opening balance + Horizon cursor snapshot for
      `LOOP_STELLAR_DEPOSIT_ADDRESS`, both `xlm` and `usdc`) via
      `POST /api/admin/operator-float/baselines` per the runbook, and
      money review signs off.
- [x] **R3-4 · Auto-refund on redemption-null exhaustion (+ policy).** _M · 💰 + policy decision._
      **RESOLVED 2026-07-10 (operator decision):** NO auto-refund. The existing `notifyRedemptionBackfillExhausted` Discord page + a manual operator decision IS the policy (auto-refunding is unsafe — a fulfilled-but-no-code order may have been genuinely paid to CTX). A manual refund of such an order now flows through the A5-4 fulfilled-order-refund-with-attestation path (`POST /api/admin/orders/:orderId/refund`). Linkage documented in `docs/runbooks/redemption-backfill-exhausted.md`.
- [x] **R3-6 · Page the drift channel on money-path contract drift.** _S · 💰._

## Phase 2 — Auth / security (fail-open or bypass risk)

- [x] **R3-12 · Guard the step-up middleware CTX fail-open.** _S · 🔐._
      `auth/admin-step-up-middleware.ts:84-86` lets `auth.kind === 'ctx'` through.
      Make the CTX branch fail-closed (or assert a staff gate ran).
      **Done when:** the exemption can't act as a standalone gate; `staff-route-gating.test.ts` green.
- [x] **R3-7 · Pin production to native auth at boot.** _S · 🔐._
- [x] **R3-8 · Align admin step-up OTP with the B5 per-email lockout.** _S–M · 🔐._
- [x] **R3-13 · Origin-check the redemption WebView `postMessage`.** _S · 🔐._
- [x] **AUDIT-2-E · `/__test__/mint-loop-token` has no defense-in-depth beyond `NODE_ENV`.** _S · 🔐._
      `apps/backend/src/test-endpoints.ts`, mounted from `app.ts:127-129` only
      when `NODE_ENV==='test'`, issues a full admin token pair for any
      allowlisted email with zero credential check. Not reachable in
      production today (`Dockerfile`/`fly.toml` hardcode
      `NODE_ENV=production`), so P1 not P0 — but a single env misconfig on a
      staging/preview app is unauthenticated admin-session minting. See
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md) finding E.
      **Done when:** the test-endpoints router requires a second, independent
      control (shared secret header or loopback bind) even under
      `NODE_ENV=test`.
      **Done (review-first, not yet merged):** `test-endpoints.ts` now
      requires `LOOP_TEST_ENDPOINTS_SECRET` (matched per-request via the
      `X-Test-Endpoints-Secret` header) in addition to `NODE_ENV==='test'`
      (re-checked inside the module itself); either missing/wrong → 404,
      same as unmounted. `env.ts` refuses to boot in production if the
      secret is set at all. Mocked-e2e + flywheel-e2e Playwright configs
      thread the secret through. See `docs/threat-model.md`'s AUDIT-2-E
      accepted-risk row.
- [x] **T0-3 · Make the money-invariant DB layer a required merge check.** _S · 💰 + operator._
      Enforcement, not a fix — promote the invariant checks to a required CI gate.
      **Code half done 2026-07-10 (#1614):** added
      `scripts/check-money-invariants.mjs` (`npm run check:money-invariants`)
      — a static (no live DB) presence + shape check for every
      money-critical DB object `docs/invariants.md` lists as "DB:" tier:
      the `assert_emission_conservation` trigger/function (migration
      0044, both the insert and re-entry triggers, kind-set asserted),
      the payout/settlement/interest-mint unique indexes
      (`credit_transactions_reference_unique`,
      `pending_payouts_active_emission_unique`,
      `pending_payouts_order_unique`, `pending_payouts_burn_order_unique`,
      `ctx_settlements_order_unique`,
      `interest_mint_snapshots_user_asset_period_unique`,
      `credit_transactions_interest_period_unique`), and the ledger/order
      CHECK constraints (`user_credits_non_negative`,
      `credit_transactions_amount_sign`, `orders_state_known`,
      `pending_payouts_interest_mint_asset_pinned`,
      `credit_transactions_reason_length`). Textually replays the
      migration chain's CREATE/DROP events in apply order
      (last-write-wins) so it catches both "the object was never added"
      and "a later migration dropped/narrowed it" — verified against a
      scratch copy of the migrations directory with (a) a deleted
      migration file, (b) an appended migration that `DROP INDEX`s a
      tracked unique index, and (c) a narrowed trigger `WHEN` clause; all
      three failed the check as expected, and the unmodified tree passes.
      Wired into the CI Quality job (a REQUIRED merge check) and
      `npm run verify`, so the money-invariant presence gate is live
      immediately — it does not depend on the 👤 step below.
      **👤 operator follow-up (not yet done):** `flywheel-integration`
      (the real-postgres job that runs `check:migration-parity` + the
      INV-1 ledger-drift assertion) is still not in the
      required-status-checks set. Belt-and-suspenders, not blocking —
      add it via
      `gh api repos/LoopDevs/Loop/branches/main/protection/required_status_checks`
      (see `docs/standards.md` §Branch protection on `main`). This is a
      branch-protection change; per repo guardrails only the operator
      makes it.

## Phase 3 — Scale / concurrency on the money path (before real volume)

- [x] **S4-2 · Wallet-provisioning fleet-lock (currently reads as a bug).** _M · 💰._
      **Done 2026-07-07:** `runWalletProvisioningTick` is now fleet-single-
      flighted with `withAdvisoryLock`; losing machines return `skippedLocked`
      and do not submit activation transactions.
- [x] **S4-3 · Single-flight the interest-mint Horizon reads** (interest = value creation). _S–M · 💰._
      **Done 2026-07-07:** `runInterestMintTick` is now fleet-single-flighted
      with `withAdvisoryLock`; losing machines return `skippedLocked` before
      user/Horizon reads.
- [x] **S4-6 · Bound the admin ledger-drift scan.** _S · 💰._
      **Done 2026-07-07:** admin reconciliation now uses a transaction-local
      2s statement timeout and a 30s success cache, with focused unit coverage.
- [ ] **S4-1 · Stellar payout throughput ceiling** (the one architectural item). _L · 💰._
      **2026-07-10: code shipped** (review-first PR open, not yet merged) —
      `docs/adr/044-payout-throughput.md` picks Stellar channel accounts (N
      pre-funded sequence-owning accounts; op-level `source` override keeps
      the operator/issuer as the real funder) over operator/issuer account
      sharding or batching. `LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS` unset
      (default) is byte-identical to pre-ADR-044 behaviour — the A8
      fleet-wide leader lock is unchanged, channels add parallelism WITHIN
      one leader's tick. **Still open (👤):** operator provisions + funds N
      channel accounts and confirms real throughput scaling.

## Phase 4 — Admin / support money tooling (ops can't intervene today)

- [x] **A5-1 · Order re-drive lever** (biggest hole). _M · 💰._
      **Done 2026-07-09, paid-only after money-review (review-first PR #1609 open, not yet
      merged):** `POST /api/admin/orders/:orderId/redrive` — admin-tier + step-up (`order-redrive`
      scope), ADR-017 envelope. Re-runs `procureOne` for a stuck **`paid`** order the worker never
      drained (the recovery sweep only touches `procuring`). Safe under concurrency:
      `markOrderProcuring`'s CAS is a hard single-flight gate, so never a double-procure or
      double-pay (INV-7). **`procuring` orders refused** (`ORDER_REDRIVE_IN_PROGRESS`) — a
      money-reviewer found force-reverting a procuring order to re-procure it can strand a CTX-paid
      order (INV-6) and narrowly double-pay (INV-7); stuck procuring orders are auto-recovered by
      the sweep, and safe manual re-procure needs a liveness signal + bounded Horizon I/O (follow-up).
      No new money logic — reuses `procureOne` / `ctx_settlements`. Cancel-and-refund deferred to A5-4.
- [x] **A5-4 · Order-bound refund UI + fulfilled-order policy.** _M · 💰 + policy._
      **Done 2026-07-10 (review-first PR open, not yet merged):** new `POST /api/admin/orders/:orderId/refund`, admin-tier + step-up (`order-refund` scope), ADR-017 envelope. Operator-decided policy: paid/procuring/failed refund directly; **fulfilled** refundable ONLY behind a required code-unused attestation (`{codeUnused,attestationNote}`). No new money path — dispatches to the EXISTING primitives per `payment_method`: xlm/usdc → `applyOrderAutoRefund`→A6 `refundDeposit` (on-chain to sender); credit → `applyAdminRefund` (mirror); **loop_asset fails closed** (R3-2 posture). paid/procuring fenced to `failed` first; procuring-with-CTX-paid refused (`loopPaidCtx`). INV-8-idempotent (rides the migration-0013 index + deposit-refund claim guard — no new uniqueness logic). Web `RefundOrderPanel` with the fulfilled-order warning + attestation checkbox. Double-spend risk operator-accepted (attestation + audit) — `docs/threat-model.md`.
- [ ] **A5-6 · Make stuck-orders / stuck-payouts support-visible.** _M · 💰._
- [x] **A5-9 · Bulk actions + drift-correction action.** _M · 💰._
      **Drift-correction RESOLVED 2026-07-10 (operator decision):** NO new drift-write primitive. Drift is corrected via the EXISTING per-user credit-adjust (`POST /api/admin/users/:userId/credit-adjustments`, step-up + reason + audit, already conservation-trigger + INV-5-cap guarded), driven by the A5-8 ledger browser + R3-1 reconciliation tools. Procedure documented in `docs/runbooks/ledger-drift.md` + `operator-float-drift.md`. Bulk selection (UX-only over already-guarded single writes) deferred.
- [ ] **A5-8 · Fleet-wide ledger browser.** _M · 💰._
- [ ] **A5-7 · Per-subject audit view.** _M._
- [ ] **A5-2 · Admin session-revocation UI.** _S–M · 🔐._
- [x] **A5-3 · Login / OTP support tooling.** _S–M · 🔐._ Shipped 2026-07-10 — see readiness-backlog A5-3 for the full tier reasoning.

## Phase 5 — Fraud / abuse controls (currently absent)

- [ ] **B-3 · User-level fraud/abuse controls.** _L · 💰 + design/ADR._
      No velocity limits, duplicate-account detection, or chargeback handling today
      (`loop-create-checks.ts` only does a balance check). Needs a design pass first.

## P2 / follow-ups (lower severity, not blocking)

Smaller items surfaced while working an item above; not re-scoped to the
depth of a numbered ID, but worth tracking so they don't get lost.

- [x] **P2-a · `payments/horizon-balances.ts:92-104` has the same
      vacuous-issuer pattern AUDIT-2-A fixed on the deposit-matching path.**
      _S · 💰._ Found while fixing AUDIT-2-C. This is the operator-balance
      READ path (feeds procurement asset choice + treasury display), not a
      payment-authorization gate, so it's lower severity than finding A was
      — but the same "unconfigured issuer silently matches anything" shape
      is worth closing for consistency and to stop it from misreporting
      operator treasury balances against a spoofed/self-issued asset.
      **Done (review-first, not yet merged):** `getAccountBalances` now
      mirrors `isMatchingIncomingPayment`'s fail-closed shape — a 'USDC'
      code balance is only counted when `usdcIssuer` is configured AND
      matches; unset issuer now reads as `usdcStroops: null` (unknown),
      never "any issuer accepted." Verified the three consumers
      (`procurement-asset-picker.ts`'s `readUsdcBalanceSafely` — null
      already means "haven't read a balance" and defaults to USDC, no
      behavior change beyond correctness; `admin/treasury-builders.ts`'s
      `buildAssets` — already renders `null` as `—`;
      `payments/operator-float-reconciliation.ts`'s `currentBalance` —
      already coalesces `null ?? 0n`) all handle the now-more-often-null
      balance safely, no divide-by/NaN/negative surprise. Test flips the
      old "MVP leniency"
      assertion in `horizon-balances.test.ts` to assert the fail-closed
      result, and was confirmed to fail against pre-fix code.
- [x] **P2-b · No order-create-time gate for a `usdc` order when
      `LOOP_STELLAR_USDC_ISSUER` is unconfigured.** _S · 💰._ Found while
      fixing AUDIT-2-C. `orders/loop-create-response.ts` lets a `usdc`
      order get created even when the issuer var is unset — the order then
      sits `pending_payment` forever because the watcher (correctly, per
      AUDIT-2-A) matches nothing on that rail. A create-time 503/4xx would
      surface the misconfiguration immediately instead of via silent
      24h-later expiry. Liveness/UX, not a money-safety gap (no unbacked
      value can move).
      **Done (review-first, not yet merged):** both
      `loop-create-response.ts` and `loop-replay-response.ts` (the
      idempotent-replay twin — same gap, same fix) now 503
      `SERVICE_UNAVAILABLE` for a
      `usdc` order when `LOOP_STELLAR_USDC_ISSUER` is unset, mirroring the
      pre-existing `loop_asset` issuer guard. `xlm`/`loop_asset`/`credit`
      create + replay are non-regression-tested unaffected. Also fixed the
      adjacent `loop-create-response.ts` "Fail-open" comment on the
      oracle-down zero-amount path — it's fail-SAFE (the watcher's amount
      check is unaffected; a 0-amount URI can't underpay), per the
      orders-sweep P2 finding.
- [ ] **P2-c · `orders/transitions.ts` `loop_asset` debit residual: a
      pre-existing `pending_payment` `loop_asset` order can still be paid
      via direct on-chain payment.** _👤 operator query + 💰._ AUDIT-2-B
      closed the create/redeem gate going forward, but any `loop_asset`
      order that was already `pending_payment` before #1603 merged remains
      payable by whoever holds its deposit memo, since `markOrderPaid`'s
      debit branch itself has no phase check. Recommend a deploy-time
      one-off cleanup — `UPDATE orders SET state='expired' WHERE
payment_method='loop_asset' AND state='pending_payment'` — plus a
      periodic monitoring query (any `loop_asset` order re-entering
      `pending_payment` post-cleanup is unexpected in Phase 1 and worth an
      alert) so the residual doesn't silently reopen.
- [x] **P2-d · `account_merge` into the deposit address is outside the
      recovery trail.** _S · 💰._ Found in the #1604 (AUDIT-2-C) money
      review. AUDIT-2-C surfaced unrecognized `payment` /
      `path_payment_strict_*` deliveries, but an `account_merge` op moves
      the entire source account's XLM into the deposit account via
      Horizon's `account` / `into` fields (not `to`), so
      `isInboundDeliveryToAccount` (`payments/horizon.ts`) doesn't see it
      and no skip row is written. Rare/unusual vector (not the normal
      wallet-funding path the finding targeted) and pre-existing (the same
      op type was already excluded from `isMatchingIncomingPayment`), so
      it's a residual to track, not a launch blocker — extending the
      discriminator to the merge fields would close it.
      _Still open — not addressed in the P2-a/P2-b PR (2026-07-09); scope
      was the horizon-balances + usdc order-create issuer gaps only._
      **Fixed 2026-07-10 (audit-2 P2 cleanup PR):** decided to fix rather
      than defer — turned out to be exactly the "clean, small extension"
      case. Added two new optional Zod fields to `HorizonPayment`
      (`payments/horizon.ts`): `into` (account_merge's destination) and
      `source_account` (the field every Horizon operation carries for
      its submitting account — used here for account_merge's source; an
      earlier draft of this fix incorrectly assumed account_merge reused
      the pre-existing `account` field, which is actually create_account
      -only — caught and corrected during the money-reviewer pass, which
      independently verified the field semantics against the vendored
      `@stellar/stellar-sdk` Horizon API types rather than trusting the
      comment). `isInboundDeliveryToAccount` now recognizes a successful
      `account_merge` whose `into === account` as an inbound delivery —
      the security-relevant half of this fix, confirmed correct against
      the SDK types — routed through the SAME #1604 `unrecognized_deposit`
      `recordSkip` path (live tick + retry-sweep re-evaluation, both call
      sites already shared the discriminator). Dust floor: `account_merge`
      reports no `amount` field at all (Horizon only exposes the merged
      quantity via the separate effects API, not called here), so the
      existing amount-based dust check never excludes a merge — every
      inbound merge is recorded, which is fine because the op is
      rare-to-never on this account. Throttled alert: unaffected —
      `recordSkip` already fans out through the #1604
      `notifyUnrecognizedDepositRecorded` throttle regardless of the
      underlying op type, so no new flood vector. `isMatchingIncomingPayment`
      (order-payment matching) deliberately stays untouched — an
      `account_merge` delivers the sender's WHOLE remaining balance, not a
      chosen "I'm paying this order" amount, so it must never mark an
      order paid; confirmed `processPayment` returns `no_match` for
      account_merge before any memo/order lookup, so `markOrderPaid` is
      structurally unreachable for this op type regardless of the
      source-field mixup above. Also improved `describeUnrecognizedDeposit`
      (`payments/watcher.ts`) with an `account_merge`-specific branch
      (reads `source_account`/`into` instead of `from`/`amount`, which
      account_merge never populates) so a recorded skip row's detail
      string is actually useful to an operator instead
      of reading "from unknown ... amount unknown" across the board.
      Extended `isInboundDeliveryToAccount`'s existing unit-test
      coverage (`horizon.test.ts`) plus a full watcher-tick-level test
      pair (`watcher.test.ts`: inbound merge records, outbound merge
      doesn't — the account_merge twin of the pre-existing payment
      noise-guard test) — all four confirmed to fail against pre-fix code.
- [ ] **P2-e · `sweepStuckProcurement` is not S4-8 single-flighted.** _S ·
      💰 · still open, not addressed in the P2-a/P2-b PR (2026-07-09)._
      Efficiency-only per the AUDIT-2 sweep — the work itself is
      row-lock-partitioned (`UPDATE ... WHERE state = ...`), so concurrent
      runs can't double-act on the same row. See
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md)
      P2 findings (orders).
- [x] **P2-f · Emission-conservation DB trigger (migration 0044) is
      integration-tested only for `kind='emission'`.** _S–M · 💰 · still
      open, not addressed in the P2-a/P2-b PR (2026-07-09)._ The same
      trigger also gates `order_cashback` and `interest_mint` rows per its
      `WHEN` clause, but those paths lack equivalent direct integration
      coverage. See
      [`audit-2026-07-09-money-auth-sweep.md`](./audit-2026-07-09-money-auth-sweep.md)
      P2 findings (credits).
      **Fixed 2026-07-10 (audit-2 P2 cleanup PR):** the migration's
      INSERT-side trigger only `WHEN`s on `kind='emission'` by design (a
      fresh `order_cashback`/`interest_mint` INSERT moves the mirror
      atomically in the same app-layer txn, so it doesn't need the DB
      fence at insert time — see the migration's own header comment); the
      real double-mint vector for those two kinds is the UPDATE-side
      re-entry trigger (`OLD.state = 'failed' AND NEW.state != 'failed'`),
      which DOES gate all three kinds. Added two new integration tests to
      `__tests__/integration/admin-writes.test.ts`'s existing "hardening
      A1" describe block, mirroring its pre-existing
      "retry-after-backfill double mint" (kind='emission') case: seed a
      terminally-failed `order_cashback` (resp. `interest_mint`,
      GBPLOOP-only per the kind_shape CHECK) row, consume the SAME
      headroom with a legitimate `emission` backfill (the trigger sums
      all three mint kinds together, so this is the real cross-kind
      double-mint shape), then retry the failed row via the generic
      `POST /api/admin/payouts/:id/retry` endpoint (kind-agnostic —
      `resetPayoutToPending` doesn't discriminate by kind) and assert 409
      `EMISSION_EXCEEDS_UNEMITTED_BALANCE` + the row stays `failed`. Ran
      locally against a throwaway postgres container; both new tests
      pass on the current trigger and were confirmed to FAIL (200 instead
      of 409) against a deliberately-narrowed trigger WHEN clause
      (`kind = 'emission'` only) — proving they actually exercise the
      re-entry fence for the other two kinds, not just re-testing
      emission.
- [x] **P2-g · `payments/operator-float-reconciliation.ts`'s
      `extractOperatorMovement` has the same vacuous-issuer shape P2-a just
      fixed on the balance-read sibling.** _S · 💰 · found by the
      money-reviewer pass on the P2-a/P2-b PR (2026-07-09), out of that
      PR's scope, still open._ `extractOperatorMovement` (~line 158)
      classifies a Horizon payment as `asset: 'usdc'` on
      `args.usdcIssuer === null || p.asset_issuer === args.usdcIssuer` —
      when `LOOP_STELLAR_USDC_ISSUER` is unset, any code-"USDC" payment on
      the operator account is counted into the float-reconciliation
      movement ledger regardless of issuer, the same "unconfigured issuer
      accepts anything" shape as P2-a. Lower severity than P2-a (this is
      an audit-trail classification for the R3-1 float reconciler, not a
      balance figure or a payment-authorization gate), but worth closing
      for the same consistency reason. Note: the P2-a/P2-b PR's fix to
      `getAccountBalances`'s `currentBalance` consumer means
      `actualBalanceStroops` now reads `0` for USDC whenever the issuer is
      unset — if this movement-classification sibling stays unfixed, an
      unset-issuer deployment would show `expectedBalanceStroops` still
      counting unpinned "USDC" movements while `actualBalanceStroops`
      reads 0, which pages the drift alert (correctly loud, but this
      residual is worth closing rather than relying on the alert alone).
      **Fixed 2026-07-10 (audit-2 P2 cleanup PR):** mirrored the exact
      fail-closed shape #1601 (`payments/horizon.ts`) and #1607/P2-a
      (`payments/horizon-balances.ts`) already established — changed
      `args.usdcIssuer === null || p.asset_issuer === args.usdcIssuer` to
      `args.usdcIssuer !== null && p.asset_issuer === args.usdcIssuer`. No
      configured issuer now means the payment is never extracted as a
      `usdc` movement at all (falls through to the function's existing
      `return null`, the same path any other unrecognized asset already
      takes) rather than landing in `operator_wallet_movements` as
      `classification: 'unclassified'` — there's no third "unknown asset"
      value the `asset` column can hold (a CHECK constraint pins it to
      xlm-or-usdc only), so exclusion-from-indexing is the only
      fail-closed shape available, and it's the same one the sibling
      fixes use. Confirmed
      this module makes no balance-adjusting writes (classification/
      audit-trail metadata only, per the file's own header) — the fix
      only changes what `operator_wallet_movements` records and what
      `expectedBalanceStroops` sums for an unset-issuer deployment, never
      a ledger/mirror value. Net effect on the P2-a interaction noted
      above: with both fixed, an unset-issuer deployment's USDC run now
      reads `actualBalanceStroops: 0` and `expectedBalanceStroops`
      excluding the same unpinned movements — no more forced drift-page
      from this specific cause (production boot-fails without the issuer
      configured anyway, absent an explicit override, so this mostly
      matters for a deliberately-disabled-USDC-rail deployment where
      there's no legitimate USDC traffic to miss in the first place).
      Added a fail-closed unit test (any-issuer USDC with no configured
      issuer → not extracted) plus a control test (matching-issuer USDC
      still classifies correctly when configured) to
      `operator-float-reconciliation.test.ts`; the fail-closed test was
      confirmed to fail against pre-fix code.

## Ongoing — remaining money/auth test coverage

- [x] **Q6-3 · Web money-write client tests** (`admin-write-envelope` step-up + Idempotency-Key). _S–M._
      **Done 2026-07-10 (test-only PR — no product source changed, self-
      merged once CI was green):** the shared client envelope
      (`apps/web/app/services/admin-write-envelope.ts`'s
      `generateIdempotencyKey`, `authenticatedRequest`'s `withStepUp` →
      `X-Admin-Step-Up` header plumbing in `api-client.ts`, and the
      `useAdminStepUp` retry hook) had one CF-09-style
      reuse-key-across-retry test (`admin.payouts.$id.test.tsx`,
      `retryPayout` only) and otherwise zero direct coverage — the
      header-attachment logic in `authenticatedRequest` and the four
      other named writers (credit-adjust, order-redrive, clear-otp-
      lockout, revoke-sessions) were untested at the client layer;
      `CreditAdjustmentForm.test.tsx` in particular covered only the
      pure `parseAmountMajor` helper, nothing about the mutation flow.
      Added: `admin-write-envelope.test.ts` (key uniqueness + the
      `crypto.randomUUID` / fallback branches), `admin-step-up.test.ts`
      (`mintAdminStepUp` request shape + error propagation), and one
      service-level test per named writer —
      `admin-user-credits.test.ts` (`applyCreditAdjustment` /
      `applyAdminEmission`), `admin-orders.test.ts` (`redriveOrder`),
      `admin-user-auth-state.test.ts` (`clearAdminOtpLockout`),
      `admin-user-sessions.test.ts` (`revokeUserSessions`) — each
      pinning its Idempotency-Key / reason / `withStepUp` contract,
      including the two writers that deliberately opt OUT of parts of
      the envelope (`clearAdminOtpLockout`: keyed + reasoned but NOT
      step-up-gated; `revokeUserSessions`: none of the three). Extended
      `api-client.test.ts` with the `X-Admin-Step-Up` header contract:
      attached when `withStepUp: true` and the store holds a token,
      omitted when `withStepUp` is unset (even with a token held —
      guards against the header leaking onto a non-gated write),
      omitted (not empty-string) on the first call when the store is
      empty, and preserved across the silent access-token-refresh retry
      path. Extended `OrderRedrivePanel.test.tsx` and rewrote
      `CreditAdjustmentForm.test.tsx` with the full submit → confirm →
      step-up-retry flow, each with its own CF-09 reuse-key-across-
      retry assertion, a cancelled-step-up-does-not-retry assertion, and
      non-step-up-error-does-not-retry assertions. Non-vacuousness:
      every new assertion was confirmed to fail against a deliberately
      broken version of the code it pins (constant idempotency key;
      step-up header dropped on the post-refresh retry; header attached
      unconditionally regardless of `withStepUp`; `applyCreditAdjustment`
      / `redriveOrder` ignoring the caller-supplied key both at the
      service layer AND — by temporarily breaking the two forms'
      `mutationFn` to re-mint the key on retry — at the component layer;
      `clearAdminOtpLockout` accidentally gaining `withStepUp: true`;
      `revokeUserSessions` accidentally gaining an `Idempotency-Key`;
      `mintAdminStepUp` sending the wrong body field name), then
      reverted; full `apps/web` suite stayed green throughout
      (201 files / 1539 tests). No envelope bug found — the
      idempotency-key-reuse-on-retry contract holds for every step-up-
      gated writer tested, and the two deliberately-ungated writers
      match their documented contracts.
- [x] **Q6-4 · Gating loop-native purchase-through-the-UI E2E** (the real production path). _M._
      **Done 2026-07-10 — review-first PR open (not yet merged; this
      PR touches a one-line product fix alongside the new e2e suite,
      so it does NOT self-merge — see below):** confirmed the gap the
      item names was real (not stale): `tests/e2e-mocked/purchase-flow.test.ts`
      drives the **legacy** CTX-proxy path (`LOOP_AUTH_NATIVE_ENABLED`
      unset in `playwright.mocked.config.ts`); `tests/e2e-flywheel/flywheel-walk.test.ts`
      seeds an **already-fulfilled** loop-native order directly via SQL
      in its `global-setup.ts` and only walks the read/consumer side
      (`/orders` list rendering) — neither drives `createLoopOrder`
      (`POST /api/orders/loop`, gated on `config.loopOrdersEnabled`)
      through a browser, and neither simulates an on-chain deposit
      landing at all. Closed the full gap rather than a partial slice:
      added `tests/e2e-loop-purchase/purchase-flow.test.ts` +
      `playwright.loop-purchase.config.ts` (a third, separate
      Playwright config/webServer — see its header comment for why it
      can't share `playwright.flywheel.config.ts`'s backend process:
      this suite needs `LOOP_PHASE_1_ONLY=true` to pin the CTX-payment
      rail to XLM deterministically, which hides the cashback headline
      `flywheel-walk.test.ts` asserts on) that drives: sign-in (reusing
      the existing `/__test__/mint-loop-token` + sessionStorage-plant
      technique `flywheel-walk.test.ts` already established — loop-native
      OTPs have no inbox to scrape, same rationale as that suite) →
      browse to a merchant → pick the XLM payment rail → enter an
      amount → `POST /api/orders/loop` (asserted against the REAL
      captured API response, not a hardcoded assumption) → the payment
      step renders the deposit address/memo/asset-amount → a new
      `tests/e2e-loop-purchase/fixtures/mock-horizon.mjs` fixture
      simulates the matching on-chain XLM deposit landing (serves
      `GET /accounts/:id/payments` for the payment watcher's poll, plus
      `GET /accounts/:id` + `POST /transactions` so `@stellar/stellar-sdk`'s
      `Horizon.Server` can build/sign/submit the procurement worker's
      own outbound payment to CTX — investigated the SDK's actual
      wire contract (`AccountResponse` only reads `account_id`/`sequence`;
      `submitTransaction` skips XDR-decoding when the response omits
      `result_xdr`) rather than assuming a full Horizon mock was
      infeasible) → the payment watcher marks the order `paid` →
      the procurement worker settles with `tests/e2e-mocked/fixtures/mock-ctx.mjs`
      (reused unmodified except a checksum-valid destination address —
      the fake placeholder the legacy path never validated fails
      `stellar-sdk`'s `Operation.payment` StrKey check) → `fulfilled` →
      the redemption link is revealed in the UI and cross-checked
      against `GET /api/orders/loop/:id`. Both worker tick intervals
      run at 1s (config-only) so the polling waits stay fast without
      trading determinism for speed — every wait is on a UI/API
      assertion (`toBeVisible`/`toPass`), never a fixed sleep.
      Non-vacuousness — two proofs, not one: (1) the test caught a REAL
      production bug on its first honest run (below) before any fix
      existed; (2) after the fix, ran the suite with the "Ready"
      state-label assertion retargeted to a string the app never
      renders — the test failed red (timeout) exactly as expected;
      reverted before landing. Runs as a second step in the existing
      CI `test-e2e-flywheel` job (not a new job, not a new required
      check — same posture `flywheel-walk.test.ts` already has).
      **⚠️ Found + fixed a real P1 production bug, not just a test
      gap:** `PurchaseContainer.tsx`'s loop-native branch called
      `setLoopCreate(result)` after `POST /api/orders/loop` succeeded
      but never called `store.startPurchase(merchant.id, ...)` (only
      the legacy branch did). The `<LoopPaymentStep>` render is gated
      on `isCurrentMerchant = store.merchantId === merchant.id`, so on
      any first-touch session (`store.merchantId` starts `null`) that
      guard stayed false forever — the order was created server-side
      (a real order row, a real deposit memo) but the UI silently fell
      back to the amount-selection form with no visible next step. No
      existing test (unit or e2e) exercised this transition, which is
      exactly the "UI/config regression on the real path currently
      passes every gate" risk this item's own description warned
      about. Fixed with one added line
      (`store.startPurchase(merchant.id, merchant.name);` right before
      `setLoopCreate(result)`) — verified against the actual guard
      logic (`loopCreate` is already merchant-scoped local state via
      the mount effect's `[merchant.id]` cleanup, so this call exists
      purely to satisfy the shared-store guard the same way the legacy
      branch does, touching none of the legacy-shaped store fields the
      loop-native render path reads). **Because this PR touches
      product source (`apps/web/app/components/features/purchase/PurchaseContainer.tsx`),
      it is NOT self-merged** — left open, review-first, per the
      CLAUDE.md rule that a product-source change (even a one-line,
      clearly-scoped bug fix a test forced into the open) needs a
      human pass before merge. Also touched
      `tests/e2e-mocked/fixtures/mock-ctx.mjs`'s hardcoded fake Stellar
      destination address (not a checksum-valid StrKey, which the
      legacy path never validated but `stellar-sdk`'s
      `Operation.payment` does) — a test-fixture constant, not runtime
      logic. No `apps/backend/src/test-endpoints.ts` change was needed
      (workers already had to run for `config.loopOrdersEnabled` to be
      reachable at all, so the background-tick approach needed no new
      manual-trigger endpoint).
- [x] **Q6-4b · Loop-native payment-screen remount fragility** (Q6-4 follow-up). _S–M · 💰._
      **Done 2026-07-10 — review-first PR open (not yet merged):** Q6-4's e2e work
      fixed the first-touch guard (`store.startPurchase`) but flagged a deeper
      problem: the loop-native payment screen renders ONLY from `loopCreate`,
      ephemeral `useState` in `PurchaseContainer.tsx`, never re-derived from the
      server. ANY remount mid-payment — a re-render that fires the container's
      `[merchant.id]` cleanup effect, a slow-connection late fetch, a tab refresh —
      strands the user at the amount-selection form despite a live, payable order
      existing server-side (real order row, real deposit memo, real expiry).
      Added `apps/web/app/hooks/use-loop-order-restore.ts`, made
      **SERVER-AUTHORITATIVE** after two rounds of money-review (see below):
      what's persisted to sessionStorage/secure-storage is a **POINTER ONLY**
      — `{ merchantId, orderId }` — under a new key
      (`LOOP_NATIVE_PENDING_ORDER_KEY = 'loop_native_pending_order'` in
      `apps/web/app/native/purchase-storage.ts`, separate from the legacy path's
      `PENDING_ORDER_KEY`). On mount the hook GETs the order
      (`GET /api/orders/loop/:id`, owner-scoped) and rebuilds the ENTIRE pay
      screen from that server response, re-arming `isCurrentMerchant` (via
      `store.startPurchase`, same call Q6-4 added). **No payment-directing field
      (destination, memo, amount, asset code/issuer, SEP-7 `paymentUri`) is ever
      read from client storage** — so there is no client-side field to tamper.
      To make that possible the **`GET /api/orders/loop/:id` read view was
      extended** (`LoopOrderView` in `packages/shared/src/loop-orders.ts` +
      openapi `orders-loop-reads.ts`) with the server-derived guidance fields
      `assetAmount`/`paymentUri`/`assetCode`/`assetIssuer`, populated in
      `apps/backend/src/orders/loop-read-handlers.ts` for a non-terminal on-chain
      order by **reusing the exact idempotent-POST-replay derivation** — the
      live oracle/FX re-quote + SEP-7 build, extracted from `loop-replay-response.ts`
      into `apps/backend/src/orders/loop-payment-instructions.ts`
      (`deriveLoopPaymentInstructions`, no re-implementation — `replayOrderResponse`
      is now a thin wrapper over it). Re-quoting on read is correct: it yields the
      current required guidance for a still-pending order, and the deposit watcher
      re-validates sufficiency at settlement regardless (the price feed's 60s cache
      is shared with the watcher, so the 3s UI poll adds no per-poll oracle call).
      Money-safety: read-only (GET only, never re-`POST`s — no double-order);
      owner-scoped GET → an unknown/other-user/tampered order id 404s and the
      pointer is cleared (no cross-user leak); a different order the SAME user owns
      just rebuilds THAT order's real server payload (still safe); refuses terminal
      orders + clears; 20-minute client TTL bounds an abandoned pointer. Also
      hardened `LoopPaymentStep.tsx`: a non-retryable 404/403 on the order poll now
      stops the 3s refetch loop and fires a new `onOrderNotFound` callback instead
      of spinning on "Creating order…" forever.
      **Two money-review rounds:**
      Round 1 (self-run `money-reviewer`) on the original _persist-the-full-create-
      response_ design found 1 P1 + 2 P2, all fixed at the time (SEP-7-embedded
      destination/memo cross-check; a save/refresh storage race; an explicit
      `expiresAt` so the storage layer's 15-min default didn't undercut the 20-min
      TTL).
      Round 2 (independent lead review) found the residual P1 that motivated the
      server-authoritative rewrite: **AMOUNT + ASSET were never cross-checked**,
      only destination+memo — so a tampered persisted blob with a 100×-inflated
      `amountMinor`/`assetAmount` and a `paymentUri` whose `amount=` was inflated
      (but destination+memo kept correct) passed every guard, and the native
      "Open in wallet" deep-link asked the user's wallet for 100× to Loop's real
      deposit address (overpay = user loss; underpay/wrong-asset = stranded funds).
      It never broke Loop's ledger (the watcher computes required amount/asset from
      server `chargeMinor`/`currency`/`method` + env issuers, so INV-3/7/8/9 held)
      — a P1 user-facing payment-misdirection, not a P0. The fix ELIMINATES the
      tamper surface rather than adding a fourth cross-check: with pointer-only
      persistence + full server rebuild, there is nothing payment-directing in
      storage to compare. **Chose the GET-extension (read-only) over the
      reviewer's idempotency-key-replay fallback** because it needs no re-POST and
      so carries zero double-order risk. Tests:
      `apps/web/app/hooks/__tests__/use-loop-order-restore.test.ts` (26 cases —
      pointer-only validator incl. "ignores injected extra keys",
      `loopOrderViewToCreate` server rebuild per method, a TAMPER-IGNORED case
      asserting the restored create uses SERVER amount/asset/paymentUri not the
      injected 100× blob, restore/no-restore per state, 404/403/401 clear,
      transient-500 + oracle-null-guidance keep the pointer, storage-race
      non-clobber, pointer-carries-no-payment-field, TTL/expiresAt) +
      `apps/web/app/components/features/purchase/__tests__/PurchaseContainer.loop-order-restore.test.tsx`
      (8 cases — first-touch regression guard; real unmount+remount rebuilds the
      pay screen from the server and asserts the rendered amount + deep-link href
      are the SERVER's; a **SERVER-AUTHORITATIVE tamper test** that seeds a 100×
      poisoned blob and asserts the DOM shows the server's `$10.00` /
      `10.0000000 USDC` / real href — **proven to FAIL against the pre-fix
      blob-trusting code** which rendered `$1,000.00` + the attacker href; expired/
      404 clear; fulfilled clears without kicking off "Ready"; no-op; legacy path
      untouched) + backend `loop-get-handler.test.ts` Q6-4b cases (overlay for
      pending on-chain, loop_asset code/issuer, null for terminal/credit/derivation-
      failure). Full web suite green, full `npm run verify` green. Two
      `money-reviewer`/lead passes completed pre-merge (see PR).
- [x] **Q6-5 · Admin / support UI E2E smoke.** _M._
      **Done 2026-07-10 (test-only PR, no data-testid needed — every
      selector resolves against existing roles/text/`title` attributes
      — self-merged once CI was green):** new
      `tests/e2e-admin-support/admin-dashboard.test.ts` +
      `global-setup.ts` + `playwright.admin.config.ts` (own port
      range, own `staff_roles` seed — an admin-tier user, a
      support-tier user, and a "customer" user with a stuck `paid`
      order, a `fulfilled` order + cashback ledger row, an
      OTP-lockout row, and a live refresh-token row, all fixed ids).
      Authenticates via the same test-only `/__test__/mint-loop-token`
      endpoint the flywheel suite uses (grants a session, not a role —
      the ADR 037 role grants are a direct SQL seed). Two tests:
      **admin** — `/admin` dashboard + admin-only nav tab, stuck-orders
      (A5-6), the fleet ledger browser with a filter + pagination
      affordance (A5-8), the orders list, and a user-360 page (A5-7
      audit timeline + A5-3 auth-state) all render real seeded data;
      the order re-drive (A5-1) and refund (A5-4) write affordances
      render and trip the ADR 028 step-up gate on submit (asserted via
      `waitForResponse` on the real 401 `STEP_UP_REQUIRED`, then
      cancelled — neither write completes, since both are real
      money-moving primitives and completing them is the money-review-
      gated backend integration tests' job); revoke-sessions (A5-2,
      which has no step-up by design) is completed end-to-end as the
      one safe write, with a post-reload check that the audit timeline
      picked up the resulting `session_revoked` row. **support** — the
      same read surfaces render, but every admin-only write affordance
      and nav/page (e.g. `/admin/staff`) is absent or denied. Runs as
      a third step in the CI `test-e2e-flywheel` job
      (`npm run test:e2e:admin`), confirmed green across 3 consecutive
      fresh-server local runs. Non-vacuousness proven directly:
      temporarily broke `AdminNav.tsx`'s `visibleTabs` to always
      return every tab regardless of role — the support test failed
      red (deterministically, `Received: 1` for the "Staff" nav link
      it expects absent) across 3 retries; reverted, suite green again
      (byte-identical diff). That exercise also caught a real bug in
      the test itself (not the product): the first version of the
      support-tier nav-tab assertion checked `toHaveCount(0)` before
      the nav had settled from its role-still-resolving `[]` state, so
      it was trivially true regardless of the underlying gate — fixed
      by waiting for a known support-visible tab first. No backend or
      product route/logic touched; the one non-test file changed is
      `apps/web/app/components/features/admin/AdminNav.tsx`, which
      ends the diff unchanged (temporary local break, reverted).
- [x] **Q6-6 · Wallet-spend + on-chain interest-mint coverage** (mint has no real-Postgres test). _M._
      **Done 2026-07-10 (test-only PR — coverage cannot demote an
      invariant, self-merged once CI was green):** added
      `apps/backend/src/__tests__/integration/interest-mint.test.ts`,
      the real-Postgres integration test this item said was missing —
      drives `runInterestMintTick` against a real DB (Horizon mocked)
      and covers: a full mint (snapshot + `credit_transactions` +
      `user_credits` + `pending_payouts` rows, cursor advance);
      sub-minor accrual carried forward across two real nights until
      it crosses a whole minor unit and mints (a genuine DB round-trip
      of the carry-forward read, not a mocked one); a zero-balance
      holder writing no rows; the cursor fast-path making a same-
      period re-run a cheap no-op; a crash-recovery re-run (cursor
      unadvanced, one user already committed) skipping without a
      double mint while a fresh user in the same tick still mints; a
      genuine duplicate-INSERT unique-violation (real
      `interest_mint_snapshots_user_asset_period_unique` 23505,
      Drizzle-wrapped) correctly classified by `isUniqueViolation`
      (`db/errors.ts`) — the AUDIT-2-D fix exercised against a REAL
      wrapped error, which the mocked unit test structurally could
      not produce; and the S4-3 fleet-wide advisory lock excluding a
      concurrent tick via a second real `pg_try_advisory_lock` session
      (a test-only mirror of the private `interestMintLockKey()` hash,
      since the function isn't exported). Every new interest-mint
      assertion was confirmed to fail against a deliberately-broken
      production code path, then reverted (5 independent breaks: the
      mirror-bump write, both idempotency layers together — breaking
      only the SELECT fast-path alone is saved by the catch-based
      classifier, confirmed empirically and now documented in the
      test's own comment — the cursor-advance gate, the
      `isUniqueViolation` cause-chain walk, and the lock-key
      derivation).
      Also added `apps/backend/src/__tests__/integration/redeem.test.ts`
      for wallet-spend (`orders/redeem.ts`, R3-9's advisory lock):
      the unit suite mocks `withAdvisoryLock` entirely, so it can pin
      the call shape but not that a REAL Postgres session-scoped
      advisory lock excludes a second, genuinely concurrent HTTP
      redemption. Because the handler's in-process `Set` fence always
      wins a same-process race first (deterministic, no `await`
      between its check and add), the test clears that fence via the
      exported `__resetRedeemFenceForTests()` seam mid-flight —
      simulating "a second machine whose in-process Set doesn't know
      about this order" — to isolate and prove the fleet-wide lock
      alone. Confirmed to fail (times out — the un-excluded second
      call also blocks on the paused Horizon mock) against a
      deliberately non-deterministic lock-key derivation, then
      reverted.
      Test-helper-only changes (no production source touched):
      `vitest-integration-setup.ts` gained a real (never-funded, freshly
      generated per process — never a hardcoded secret literal,
      `scripts/lint-docs.sh` §5b) GBPLOOP issuer/secret pair (needed so
      `resolveIssuerSigners()` actually resolves a signer — a
      placeholder-only address left GBPLOOP filtered out of the mint
      path entirely), a real operator fee-bump secret (redeem's
      `NOT_CONFIGURED` guard), and swapped the repeated-character
      `LOOP_STELLAR_DEPOSIT_ADDRESS` placeholder for a real keypair's
      public key (the redeem test is the first in the suite to build
      an actual Stellar `Operation.payment`, which does full StrKey
      checksum validation the old placeholder failed). `db-test-setup.ts`
      now explicitly truncates `interest_mint_snapshots` (previously
      swept only implicitly via `users` CASCADE). Verified none of
      these changes altered any other integration test's behavior —
      full local suite (`LOOP_E2E_DB=1`, throwaway docker postgres)
      stayed 100% green before/after (170/170), and CI's
      `flywheel-integration` job (real postgres) is the authoritative
      gate. Wallet-provisioning single-flight (S4-2) was assessed as
      already adequately unit-covered (`wallet/__tests__/provisioning.test.ts`)
      and left alone — out of scope for this pass.
- [x] **Q6-7 · Promote the real-chain run off manual-only** (schedule `e2e-real.mjs`). _S · 🟢._
      **Done 2026-07-10:** `.github/workflows/e2e-real.yml` gained a weekly `schedule:`
      trigger (Monday 03:00 UTC) alongside the existing `workflow_dispatch`, a
      `preflight` job that skips the scheduled run cleanly (no failure, just a
      `::notice::` log line) when `LOOP_E2E_REFRESH_TOKEN` / `STELLAR_TEST_SECRET_KEY`
      aren't configured, the pre-existing `concurrency` group (already present —
      confirmed `cancel-in-progress: false` so a scheduled + manual run can't
      double-spend), and a "Notify Discord on failure" step
      (`DISCORD_WEBHOOK_MONITORING`, mirroring `audit-cron.yml`'s pattern) so a broken
      real-CTX/real-Stellar contract doesn't sit silent until someone opens the Actions
      tab. `scripts/e2e-real.mjs` itself is unchanged — same script, same $0.02 Aerie
      default, same behavior on manual dispatch. Deliberately **self-merged** rather
      than review-first like the rest of this doc's items: pure CI-config (workflow
      YAML + docs), no product/money runtime code touched, actionlint-clean.
      **Still open (👤):** the schedule only actually fires once the operator has
      provisioned `LOOP_E2E_REFRESH_TOKEN` + `STELLAR_TEST_SECRET_KEY` (plus
      `GH_SECRETS_PAT` for rotation and `DISCORD_WEBHOOK_MONITORING` for the failure
      alert) as repo secrets — see `docs/deployment.md` "CI secrets (GitHub Actions)".
      Until then the weekly run skips cleanly (by design) rather than actually
      exercising the real chain.
- [x] **Q6-8 · Ratchet web coverage floors** as Q6-3/4/5 land. _S._

---

## Suggested execution order

1. **Phase 0** (verify + characterize + audit) — lowest risk, de-risks everything after.
2. **Phase 1 top four** (T0-1b, R3-2, R3-9, R3-10) + **R3-12** — the concrete money-loss / double-spend / auth-bypass bugs.
3. Remainder of Phase 1–2, then Phase 3 before opening the money taps to volume.
4. Phases 4–5 track ops readiness + fraud; can run in parallel once correctness is solid.

Full Why/Do/Done-when for every ID: [`readiness-backlog-2026-07-03.md`](./readiness-backlog-2026-07-03.md). Money invariants each item must preserve: [`invariants.md`](./invariants.md).
