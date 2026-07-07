# Money / Auth Work List (scoped + prioritized)

> The money- and auth-path work that gates real-money volume, pulled out of the
> 85-item `readiness-backlog-2026-07-03.md` and **sequenced by risk** so the
> highest-stakes correctness work is unambiguous. The backlog remains the source
> of truth for each item's full **Why / Do / Done-when**; this doc adds priority,
> effort, review type, and the workflow. Keep the two in sync (tick both).
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

- [ ] **AUDIT-1 · Verify the GBPLOOP unbacked-mint P0 actually landed.** _S · 💰 · read-only._
      Agent memory flags a GBPLOOP unbacked-mint P0 + CF-08/CF-25 regressions + a
      peg-break bug found during the 2026-07-02 wallet/staff stack rebase. Confirm
      each is fixed in `main` and hasn't regressed (`credits/interest-mint.ts`,
      `credits/payout-asset.ts`, the emission-conservation DB constraint). Output:
      a findings report, no code change.
- [ ] **Q6-1 · Direct test for `orders/ctx-settlements.ts` (0% counted).** _S–M · 💰._
      Mocked in every unit test today; add real assertions for the ADR-038 durable
      settlement-idempotency logic. Characterizes the code before anyone changes it.
- [ ] **Q6-2 · Raise coverage on the money/auth workers.** _M · 💰🔐._
      `payout-worker.ts` (42%), `ledger-invariant-watcher.ts` (50%),
      `payout-submit.ts` (61%), `otp-attempt-counter.ts`. Coverage-as-characterization
      — often surfaces bugs on its own.
- [ ] **AUDIT-2 · Adversarial money-path sweep.** _M · 💰🔐 · read-only._
      Run the `money-reviewer` / `auth-reviewer` subagents + `/review-money-diff`
      anchored on `docs/invariants.md`, across `credits/` `payments/` `orders/`
      `wallet/` `stellar/`. Catches issues not on this list; feeds new items back here.

## Phase 1 — Money correctness (can lose or double-count value)

- [ ] **T0-1b · Duplicate deposit against an already-PAID order.** _M · 💰._
      Persist the paying deposit's Horizon payment id + tx hash on the order in
      `markOrderPaid` (schema + migration); in the watcher's `unmatched` arm, record
      a _second_ deposit as refundable while the original paying deposit re-read never is.
      **Done when:** dup deposit → recorded + refundable; original paying deposit re-read → never recorded (integration test both ways).
- [ ] **R3-2 · Auto-refund delivers the wrong asset in Phase-1.** _M · 💰._
      `credits/refunds.ts:118-137` credits mirror LOOP with no `payment_method`
      branch. Branch the refund by `orders.payment_method`: xlm/usdc → on-chain to
      sender (reuse A6 `refundDeposit`/`submitPayout`); loop_asset → mirror. Must
      stay idempotent (don't break the partial-unique guard; don't double-refund vs A5-4).
      **Done when:** each method refunds in the asset it was paid; integration test per method.
- [ ] **R3-9 · Redeem in-flight fence is process-local.** _M · 💰._
      `orders/redeem.ts` `inFlightOrders` Set is per-process → two taps on the
      2-machine fleet both submit. Replace with a durable guard (short-TTL DB row /
      advisory lock / CAS on an in-redemption state); must not deadlock a legit retry.
      **Done when:** two concurrent redeems on different machines → exactly one submission (race test).
- [ ] **R3-10 · Make order-create idempotency default-on.** _S–M · 💰._
      `orders/loop-handler.ts:179-201` only dedups when the client sends
      `Idempotency-Key`. Derive a server-side key (or require the header) so a
      double-click can't double-debit a credit-method order.
      **Done when:** double-submitted credit-method order → one order / one debit (test).
- [ ] **R3-5 · Upper-band sanity check on the pay-CTX amount.** _S–M · 💰._
      `procure-one.ts:287-299` → `pay-ctx.ts` pays CTX's own SEP-7 amount with no
      ceiling. Assert it's within a boot-configured band of expected wholesale;
      out-of-band → fail-safe (refund + page) not silent overpay.
      **Done when:** an inflated mocked URI fails-safe instead of overpaying (test).
- [ ] **T0-1c · Don't record sub-dust `order_gone` deposits.** _S · 💰._
      Self-funded nuisance vector: expire your own order, spam dust to its memo.
      Skip recording deposits below `REFUND_MIN_STROOPS` in the watcher's
      `unmatched`/`order_gone` path (they can't be A6-refunded anyway).
      **Done when:** sub-dust late deposit not recorded; a refundable one still is.
- [ ] **R3-1 · Operator XLM/USDC float reconciliation.** _M · 💰._ See backlog for scope.
- [ ] **R3-4 · Auto-refund on redemption-null exhaustion (+ policy).** _M · 💰 + policy decision._
- [ ] **R3-6 · Page the drift channel on money-path contract drift.** _S · 💰._

## Phase 2 — Auth / security (fail-open or bypass risk)

- [ ] **R3-12 · Guard the step-up middleware CTX fail-open.** _S · 🔐._
      `auth/admin-step-up-middleware.ts:84-86` lets `auth.kind === 'ctx'` through.
      Make the CTX branch fail-closed (or assert a staff gate ran).
      **Done when:** the exemption can't act as a standalone gate; `staff-route-gating.test.ts` green.
- [ ] **R3-7 · Pin production to native auth at boot.** _S · 🔐._
- [ ] **R3-8 · Align admin step-up OTP with the B5 per-email lockout.** _S–M · 🔐._
- [ ] **R3-13 · Origin-check the redemption WebView `postMessage`.** _S · 🔐._
- [ ] **T0-3 · Make the money-invariant DB layer a required merge check.** _S · 💰 + operator._
      Enforcement, not a fix — promote the invariant checks to a required CI gate.

## Phase 3 — Scale / concurrency on the money path (before real volume)

- [ ] **S4-2 · Wallet-provisioning fleet-lock (currently reads as a bug).** _M · 💰._
- [ ] **S4-3 · Single-flight the interest-mint Horizon reads** (interest = value creation). _S–M · 💰._
- [ ] **S4-6 · Bound the admin ledger-drift scan.** _S · 💰._
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
