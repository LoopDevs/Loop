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

- [ ] **AUDIT-2-B · `loop_asset` payment method has no server-side Phase-1 gate (LIVE-RISK).** _M · 💰._
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
- [ ] **AUDIT-2-A · USDC deposit matching accepts any-issuer USDC when `LOOP_STELLAR_USDC_ISSUER` is unset.** _S–M · 💰 + operator._
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
- [ ] **AUDIT-2-C · Deposit watcher silently drops `no_match`/`no_memo` payments.** _S–M · 💰._
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
- [ ] **AUDIT-2-D · `interest-mint.ts` idempotency-skip catch never matches the real error shape.** _S · 💰._
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
      Remains open for production baselines/cursors, thresholds,
      operator memo policy, and money review.
- [ ] **R3-4 · Auto-refund on redemption-null exhaustion (+ policy).** _M · 💰 + policy decision._
- [x] **R3-6 · Page the drift channel on money-path contract drift.** _S · 💰._

## Phase 2 — Auth / security (fail-open or bypass risk)

- [x] **R3-12 · Guard the step-up middleware CTX fail-open.** _S · 🔐._
      `auth/admin-step-up-middleware.ts:84-86` lets `auth.kind === 'ctx'` through.
      Make the CTX branch fail-closed (or assert a staff gate ran).
      **Done when:** the exemption can't act as a standalone gate; `staff-route-gating.test.ts` green.
- [x] **R3-7 · Pin production to native auth at boot.** _S · 🔐._
- [x] **R3-8 · Align admin step-up OTP with the B5 per-email lockout.** _S–M · 🔐._
- [x] **R3-13 · Origin-check the redemption WebView `postMessage`.** _S · 🔐._
- [ ] **AUDIT-2-E · `/__test__/mint-loop-token` has no defense-in-depth beyond `NODE_ENV`.** _S · 🔐._
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
- [ ] **T0-3 · Make the money-invariant DB layer a required merge check.** _S · 💰 + operator._
      Enforcement, not a fix — promote the invariant checks to a required CI gate.

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

## Phase 4 — Admin / support money tooling (ops can't intervene today)

- [ ] **A5-1 · Order re-drive lever** (biggest hole). _M · 💰._
- [ ] **A5-4 · Order-bound refund UI + fulfilled-order policy.** _M · 💰 + policy._
- [ ] **A5-6 · Make stuck-orders / stuck-payouts support-visible.** _M · 💰._
- [ ] **A5-9 · Bulk actions + drift-correction action.** _M · 💰._
- [ ] **A5-8 · Fleet-wide ledger browser.** _M · 💰._
- [ ] **A5-7 · Per-subject audit view.** _M._
- [ ] **A5-2 · Admin session-revocation UI.** _S–M · 🔐._
- [ ] **A5-3 · Login / OTP support tooling.** _S–M · 🔐._

## Phase 5 — Fraud / abuse controls (currently absent)

- [ ] **B-3 · User-level fraud/abuse controls.** _L · 💰 + design/ADR._
      No velocity limits, duplicate-account detection, or chargeback handling today
      (`loop-create-checks.ts` only does a balance check). Needs a design pass first.

## Ongoing — remaining money/auth test coverage

- [ ] **Q6-3 · Web money-write client tests** (`admin-write-envelope` step-up + Idempotency-Key). _S–M._
- [ ] **Q6-4 · Gating loop-native purchase-through-the-UI E2E** (the real production path). _M._
- [ ] **Q6-5 · Admin / support UI E2E smoke.** _M._
- [ ] **Q6-6 · Wallet-spend + on-chain interest-mint coverage** (mint has no real-Postgres test). _M._
- [ ] **Q6-7 · Promote the real-chain run off manual-only** (schedule `e2e-real.mjs`). _S._
- [ ] **Q6-8 · Ratchet web coverage floors** as Q6-3/4/5 land. _S._

---

## Suggested execution order

1. **Phase 0** (verify + characterize + audit) — lowest risk, de-risks everything after.
2. **Phase 1 top four** (T0-1b, R3-2, R3-9, R3-10) + **R3-12** — the concrete money-loss / double-spend / auth-bypass bugs.
3. Remainder of Phase 1–2, then Phase 3 before opening the money taps to volume.
4. Phases 4–5 track ops readiness + fraud; can run in parallel once correctness is solid.

Full Why/Do/Done-when for every ID: [`readiness-backlog-2026-07-03.md`](./readiness-backlog-2026-07-03.md). Money invariants each item must preserve: [`invariants.md`](./invariants.md).
