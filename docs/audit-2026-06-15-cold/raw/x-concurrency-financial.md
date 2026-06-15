# Cross-vertical sweep — Concurrency & Financial Integrity

> Adversarial cross-vertical pass. Scope: the money & concurrency invariants
> that span orders ↔ credits ↔ payments ↔ db and that **no single-vertical
> agent can verify end-to-end** (checklist §11, §25, Part 3 flows 1–5,15).
> Where a single-vertical agent already owns a finding, this file
> **corroborates + ties it into the end-to-end flow** rather than re-filing;
> the genuinely cross-vertical / un-owned findings are marked **[NEW]**.

---

## Coverage

**Flows traced end-to-end (Part 3):**

- **Flow 1/15 Purchase→pay→procure→fulfil→payout** — client UUID
  (`orders.idempotency_key` partial-unique `orders_user_idempotency_unique`)
  → memo (`randomBytes(20)` per order) → `markOrderPaid` (state-CAS) →
  `markOrderProcuring` (state-CAS) → `markOrderFulfilled` (4-table txn) →
  `pending_payouts.order_id` unique → payout memo → Stellar
  `findOutboundPaymentByMemo`.
- **Flow 2 Emission** — fulfilment txn writes cashback CT + `user_credits`
  upsert + `pending_payouts` in **one** `db.transaction` (fulfillment.ts:67-190).
- **Flow 3 Redemption/spend** — `loop_asset` order →
  `markOrderPaid` extinguishes off-chain half (transitions.ts:62-139).
  **On-chain burn leg absent** (see X-1).
- **Flow 4 Interest** — `interest-scheduler` (UTC-date cursor) →
  `accrueOnePeriod` (per-row FOR UPDATE txn, period-cursor unique).
- **Flow 5 Withdrawal** — `applyAdminWithdrawal` (FOR UPDATE + 2-row txn +
  semantic + index fence).

**Files read in full:** db/schema.ts; credits/{ledger-invariant, adjustments,
withdrawals, refunds, accrue-interest, interest-scheduler, payout-builder,
pending-payouts, pending-payouts-transitions, liabilities}; orders/{fulfillment,
transitions, repo-credit-order, procurement, procurement-worker, loop-handler
(spend gate)}; payments/{watcher, payout-worker, payout-worker-pay-one,
asset-drift-watcher, horizon-circulation, horizon-find-outbound}; index.ts worker
wiring; fly.toml.

**Cross-cutting passes run:** double-entry conservation (§25), at-most-once
index coverage (§11/§25), idempotency end-to-end per hop (§3/§15), FOR-UPDATE /
CAS coverage on every balance mutation (§11), worker single-flight (§11),
cursor advancement safety (§11), reconciliation recoverability (§6/§18/§25).

**Invariants confirmed HOLDING (positive verification):**

- **Double-entry / conservation.** Every one of the six CT writer paths
  (cashback `fulfillment.ts:97`, spend-credit-order `repo-credit-order.ts:84`,
  spend-loop_asset `transitions.ts:111`, interest `accrue-interest.ts:156`,
  refund `refunds.ts:81`, withdrawal `withdrawals.ts:158`, adjustment
  `adjustments.ts:164`) writes the `credit_transactions` row **and** the
  matching `user_credits` delta inside the **same** `db.transaction`. No path
  writes one without the other; no path mutates a balance without a CT row.
  `sum(CT)==balance` is structurally maintained and independently checked by
  `computeLedgerDriftSql` (ledger-invariant.ts:134) + the CLI.
- **At-most-once.** Every machine-generated money write is fenced by a real
  partial-unique index, and the index predicates **do** cover the (type,ref)
  tuples used: cashback/refund/spend/withdrawal →
  `credit_transactions_reference_unique` on `(type,reference_type,reference_id)`
  (schema.ts:206-210), interest → `credit_transactions_interest_period_unique`
  on `(user,currency,period_cursor)` (schema.ts:191-193), payout →
  `pending_payouts_order_unique` + `pending_payouts_active_withdrawal_unique`.
  Verified each writer sets `referenceType`/`referenceId`/`periodCursor` to
  exactly the columns the index keys on. Adjustment is deliberately excluded
  (admin-idempotency-key + advisory lock instead). **No gap found here.**
- **Balance-mutation locking.** Every read-modify-write balance path takes
  `SELECT … FOR UPDATE` first (adjustments:151, refunds:72, withdrawals:104,
  accrue-interest:138, repo-credit-order:68, transitions/markOrderPaid:86);
  the cashback emission uses `onConflictDoUpdate … balance = balance + Δ`
  (atomic, lock-free-safe). Sign + non-negative CHECKs (schema.ts:136,
  230-237) are the DB backstop.
- **State-machine CAS.** Every order + payout transition is
  `UPDATE … WHERE state=<expected> RETURNING`; null-return = lost-race no-op.
  Correct on every transition reviewed.
- **Cursor advancement (payment watcher).** Skip rows are persisted
  **before** the cursor advances (watcher.ts:398), skipped deposits are
  re-swept first each tick, and poison payments are isolated
  (watcher.ts:353-374). No lost/duplicated-record path found.

---

## Findings

### [X-1] (corroborates v-payments P0-1 / v-credits) Redemption breaks conservation end-to-end: off-chain debit with no on-chain burn — **P0**

- **severity:** P0 / Critical (on-chain value duplication + permanent drift)
- **vertical seam:** orders (`markOrderPaid` loop_asset) ↔ credits (liability)
  ↔ payments (drift watcher) — the seam no single-vertical owner closes.
- **file:** `orders/transitions.ts:62-139`, `payments/asset-drift-watcher.ts:210`,
  `payments/horizon-circulation.ts:107-149`, `orders/loop-handler.ts:291-331`.
- **impact:** Flow 3 is the only flow where the off-chain ledger and the
  on-chain token supply are supposed to move **together**. `markOrderPaid`
  debits `user_credits` (−X) and writes a `spend` CT, but performs **no
  on-chain action** — the doc-comment at transitions.ts:38-40 promises "routes
  the inbound LOOP-asset to a treasury / **burn** account" and that leg does
  not exist (`grep burn|issuerReturn` → comments only; **ADR 036, referenced
  by the checklist, is not a file in `docs/adr/`**). Conservation is therefore
  broken across the seam: off-chain liability drops by X while on-chain
  circulation (`Horizon /assets.amount` = issued − issuer-held) stays flat
  because the inbound LOOP lands at `LOOP_STELLAR_DEPOSIT_ADDRESS`, a
  **non-issuer** account. And because ADR 010's Phase-1 topology makes
  deposit == operator, that same X is now the source pile the payout worker
  signs the **next** cashback/withdrawal payout from — one unit of cashback
  funds two on-chain payouts. The credit-method spend path is correctly
  disabled (loop-handler.ts:318) precisely to force redemptions through this
  path, so this is the live redemption mechanism, not a dead branch.
- **note:** v-payments already filed this as P0-1 (single-vertical). Logged
  here because the **conservation invariant** it violates is cross-vertical and
  is the §25 headline — confirming it from the credits + drift side too.
- **fix:** implement the issuer-return burn (payment of inbound LOOP →
  **issuer** = burn for a classic asset) idempotently inside/after the
  redemption txn; author ADR 036; split deposit≠issuer so "burn" is
  unambiguous. The emission/burn branch (`origin/fix/adr036-emission-burn`,
  per v-credits) appears to build this — gate launch on its merge.
- **ref:** checklist §18 (burn), §25 (no money created across redemption/burn).

### [X-2] **[NEW]** Workers run in-process on every Fly machine with zero cross-instance single-flight — shared operator-account sequence number is unguarded — **P1**

- **severity:** P1 / High (payout churn → terminal failures under scale; the
  one concurrency invariant no single-vertical agent checked)
- **vertical seam:** infra/config (`fly.toml`) ↔ payments (payout-worker) ↔
  orders (procurement) ↔ credits (interest) — only visible when read together.
- **file:** `apps/backend/src/index.ts:74-174` (all `start*Worker` calls run
  in the same process as the HTTP server), `apps/backend/fly.toml:63-69`
  (`auto_start_machines = true`, `min_machines_running = 1`,
  `soft_limit = 200` / `hard_limit = 250`), `payments/payout-worker.ts:22-28`
  (the load-bearing comment: _"No parallelism across rows — the operator
  account's sequence numbers serialise"_).
- **impact:** Fly will boot a **second machine** under request load
  (auto-start, soft*limit 200). Each machine independently runs the payout
  worker, payment watcher, procurement worker, interest scheduler, drift +
  pool watchers — there is **no leader election, no `FLY_MACHINE_ID` gate, no
  cross-instance advisory lock** anywhere in the worker startup path (`grep
pg_advisory|leader|FLY_MACHINE` over `src/` → only the \_admin* adjustment /
  compensation writers use `pg_advisory_xact_lock`; the workers use none).
  Consequences, by worker:
  - **Payout worker (worst).** Two machines each `listClaimablePayouts`
    (plain `SELECT`, **no `FOR UPDATE SKIP LOCKED`**) and pick _different_
    rows. Row-level at-most-once still holds (markPayoutSubmitted CAS +
    Horizon pre-check), so **no double-pay** — but the in-code assumption that
    operator sequence numbers serialise is **false across machines**: both
    sign txs against the same operator account, collide on the Stellar
    sequence number, and lose with `tx_bad_seq`. That classifies as transient
    and burns the attempt budget; sustained two-machine operation can churn
    legitimate payouts to terminal `failed` after `maxAttempts`. This is a
    real availability/correctness regression for emission + withdrawal payout,
    and it is **exactly the cross-vertical invariant the prompt targets** —
    each vertical's CAS is correct in isolation, but the shared
    operator-account _sequence-number resource_ is unsynchronised.
  - **Interest scheduler.** `tickInFlight` is a **module-level boolean**
    (interest-scheduler.ts:53) — per-process, so two machines both tick the
    same UTC-date cursor. Saved only by the period-cursor unique index
    (idempotent, surfaces as `skippedAlreadyAccrued`). **Holds, but by luck of
    the index, not by design** — the doc-comment claims the guard prevents
    "two schedulers hammering the same rows," which it does not across pods.
  - **Payment / procurement / drift / pool watchers.** Double-processing is
    absorbed by state-CAS + skip-table idempotency (no money bug), but
    duplicates every Horizon/CTX read (cost) and the drift/pool **in-memory
    transition state** (v-payments P3) diverges per machine, so over→ok pages
    can double-fire or cancel out across instances.
- **evidence:** no `processes`/`[processes]` block in fly.toml (workers are
  not isolated to a single worker machine); `min_machines_running=1` is a
  floor not a ceiling; `auto_start_machines=true` + concurrency limits make
  N>1 the expected steady state under load.
- **fix:** pin the worker set to a single instance — either a dedicated
  `[processes] worker = "node … --workers-only"` with `count=1` (HTTP
  scales independently), or a `pg_advisory_lock`-based leader election around
  each `start*Worker` so only one live process ticks. At minimum, switch
  `listClaimablePayouts` to `FOR UPDATE SKIP LOCKED` and stop documenting
  "sequence numbers serialise" as if single-process were guaranteed.
- **ref:** checklist §11 (worker coordination / single-flight, no
  double-processing), §7 (scaling), §18 (sequence-number handling under
  concurrency).

### [X-3] (corroborates v-payments P1-2) Drift equation is non-recoverable for the redemption pile — reconciliation can't self-heal — **P1**

- **severity:** P1 / High (permanent alert noise masks real over-mint; §6/§25)
- **vertical seam:** credits (liability) ↔ payments (drift watcher) — the
  reconciliation equation that joins the two off-chain/on-chain mirrors.
- **file:** `payments/asset-drift-watcher.ts:210`
  (`drift = onChain − pool − ledgerLiability×1e5`).
- **impact:** The equation subtracts the interest forward-mint **pool** but
  **not** the redeemed-but-unburned LOOP sitting in the deposit account
  (X-1). Per Part-3 flow 3 every `loop_asset` redemption drives `drift`
  positive by X and it **never recovers** (circulation flat, liability fell).
  Once past `LOOP_ASSET_DRIFT_THRESHOLD_STROOPS` the watcher latches `over`
  and can only `recover` if drift drops back — impossible without a burn. This
  is the §6/§18 "drift alert must be structurally recoverable, don't page
  permanently" failure: after enough redemptions the alert is permanent noise
  and a genuine over-mint is masked. The drift metric is the **only**
  automated cross-vertical reconciliation between the off-chain mirror and the
  on-chain tokens, so a non-recoverable equation means there is effectively no
  working reconciliation for the redemption flow.
- **fix:** until the burn ships, subtract
  `getAssetBalance(depositAccount, code, issuer)` from the equation the same
  way `poolStroops` is subtracted, so reconciliation stays honest; afterwards
  the burn makes circulation actually fall and the term disappears.
- **ref:** checklist §6, §18, §25.

### [X-4] (corroborates v-ctx P-CTX) pay-ctx idempotency hardened but payout idempotency was not — asymmetric memo-only convergence — **P2**

- **severity:** P2 / Medium (defense-in-depth gap; latent under non-random memo)
- **vertical seam:** orders (pay-ctx, hardened) ↔ payments (payout, not) —
  same `findOutboundPaymentByMemo` helper, divergent caller rigor.
- **file:** `payments/payout-worker-pay-one.ts:122-149` vs
  `orders/pay-ctx.ts` reconcile; helper `payments/horizon-find-outbound.ts:79-83`
  **returns `amount` + `assetCode` but the payout caller discards both**.
- **impact:** The stranded-order hardening (this branch's namesake) taught
  pay-ctx to refuse an idempotency match unless `prior.amount` **and** asset
  also match. The payout path calls the identical helper and converges to
  `confirmed` on `from+to+memo_type+memo` alone. Payout memos are
  `randomBytes(20)` (payout-builder.ts:80-92) so live collision is negligible
  (≈2⁻⁵⁰) — hence P2 — but this is precisely the "codify the fix as a class,
  don't patch one-off" rule (feedback_codify_review_findings): the hardening
  was applied to one of two callers of the same primitive. A future non-random
  memo, or an ops re-queue that reuses a memo, silently confirms the wrong
  amount/asset with no double-check. v-payments filed this as P2-1; logged
  here because the **asymmetry between the two sibling idempotency hops of the
  same end-to-end flow** is the cross-vertical observation.
- **fix:** pass `expectedAmountStroops` + `expectedAssetCode` into
  `findOutboundPaymentByMemo` (or assert on the returned values in `payOne`)
  so both callers of the primitive enforce memo+amount+asset uniformly.
- **ref:** checklist §3 (idempotency semantics), §18 (memo+amount+asset).

### [X-5] **[NEW]** `markOrderPaid` loop_asset spend is exempt from any duplicate-deposit guard — same memo can't double-spend, but per-deposit at-most-once relies solely on order state-CAS — **P3**

- **severity:** P3 / Low (no live bug found; flagged as the thin spot)
- **vertical seam:** payments (watcher) ↔ orders (markOrderPaid) ↔ credits.
- **file:** `payments/watcher.ts:185-275`, `orders/transitions.ts:62-139`.
- **impact:** For a `loop_asset` order, two on-chain deposits carrying the
  **same** order memo (user double-pays, or a chain reorg replays an op) both
  match the order in `findPendingOrderByMemo`; the **first** flips
  `pending_payment→paid` + debits credits, the second finds the order no
  longer `pending` (state-CAS null) → `already_paid`, no second debit. So
  at-most-once **holds** — but it rests entirely on the order-state guard, and
  the **second (excess) inbound LOOP is silently retained** at the deposit
  account with no refund/credit and (per X-1) no burn. There is no skip/credit
  for the overpay. Correct on the ledger, lossy for the user, and invisible.
- **fix:** when a matched deposit hits an already-non-pending order, record it
  (skip-table `reason='overpay'` or an ops alert) so the excess LOOP is
  reconciled rather than absorbed. Folds naturally into the X-1 burn work.
- **ref:** checklist §11 (idempotency under concurrent retries), §25
  (non-negative / no value destroyed).

---

## Summary

**Counts:** 5 findings — 1×P0, 2×P1, 1×P2, 1×P3. (P0/X-1 and P1/X-3, P2/X-4
corroborate single-vertical agents from the cross-vertical conservation side;
**X-2 and X-5 are NEW** — un-owned by any single-vertical agent.)

**P0/P1 one-liners:**

- **X-1 (P0)** Redemption debits off-chain credits with **no on-chain burn**
  (ADR 036 unwritten, burn leg absent) → on-chain value duplicated +
  conservation broken across orders↔credits↔payments. _(also v-payments P0-1)_
- **X-2 (P1, NEW)** All workers run in-process on **every** Fly machine
  (`auto_start_machines=true`, no leader election / advisory lock / SKIP
  LOCKED) → the payout worker's "operator sequence numbers serialise"
  assumption is false across instances; payouts churn to `tx_bad_seq` →
  terminal `failed` under scale. No single-vertical agent caught this.
- **X-3 (P1)** Drift equation omits the redeemed-but-unburned deposit pile →
  reconciliation alert latches `over` permanently, can't self-heal, masks real
  over-mint. _(also v-payments P1-2)_

**Scope note:** This sweep deliberately re-confirmed the **holding**
invariants (double-entry, at-most-once index coverage, FOR-UPDATE/CAS, cursor
safety) as the positive deliverable the prompt asked for — those are sound and
genuinely defended in depth. The financial-integrity risk is **not** in the
per-write ledger code (which is excellent); it is at the two cross-vertical
seams a per-file audit can't see: (1) the **off-chain↔on-chain settlement leg**
(redemption burn, X-1/X-3/X-5) and (2) the **infra↔worker concurrency
contract** (X-2). The emission/burn branch (`origin/fix/adr036-emission-burn`,
per v-credits) is reported to build the burn + drift terms — verify it closes
X-1/X-3/X-5 and add a worker-singleton/leader guard for X-2 before enabling
`LOOP_WORKERS_ENABLED` on a horizontally-scaled deploy.
