# V-CREDITS — Credits / Ledger vertical (cold audit 2026-06-15)

Branch `fix/stranded-order-hardening`. Adversarial cold read against code, not
docs/prior-audits. Scope: `apps/backend/src/credits/**` (adjustments, refunds,
withdrawals, liabilities, ledger-invariant, payout-asset/-builder/-compensation,
pending-payouts\*, accrue-interest, apy-snapshot, interest-forecast, interest-pool,
interest-scheduler), `orders/fulfillment.ts` + `cashback-split.ts` (emission side),
`orders/transitions.ts` + `repo-credit-order.ts` (spend side), `db/schema.ts`
(credit_transactions / user_credits / merchant_cashback_configs + history /
pending_payouts), `packages/shared/src/credit-transaction-type.ts`,
`cashback-realization.ts`. Cross-read `payments/asset-drift-watcher.ts`,
`index.ts` worker wiring, and the two unmerged branches
`origin/fix/adr036-emission-burn` + `origin/feat/wallet-phase-d-interest`
via `git show`/`git diff` (working tree never left this branch).

---

## Coverage

Files read in full (28 in-scope + cross-read):

- credits/: adjustments.ts, refunds.ts, withdrawals.ts, payout-compensation.ts,
  payout-builder.ts, payout-asset.ts, liabilities.ts, ledger-invariant.ts,
  pending-payouts.ts, pending-payouts-transitions.ts, pending-payouts-user.ts,
  pending-payouts-admin.ts (read via grep/exports), accrue-interest.ts,
  interest-scheduler.ts, interest-pool.ts, interest-forecast.ts, apy-snapshot.ts
- orders/: fulfillment.ts, cashback-split.ts, transitions.ts, repo-credit-order.ts,
  repo.ts (cashback denomination block)
- db/schema.ts: user_credits, credit_transactions, merchant_cashback_configs,
  merchant_cashback_config_history, orders (charge/cashback cols), pending_payouts
- shared: credit-transaction-type.ts, cashback-realization.ts
- cross: payments/asset-drift-watcher.ts, index.ts (scheduler/watcher gating)
- tests: enumerated credits/**tests** (16 files), orders/**tests**, admin/**tests**
- branches: docs/adr/036, credits/emissions.ts, credits/interest-mint.ts,
  payout-worker-pay-one.ts, asset-drift-watcher.ts, issuer-signers.ts (all
  branch-only; inspected via git show — see Main-vs-branch).

Verticals deliberately NOT covered here (owned elsewhere): the Stellar submit
worker proper (V-PAYMENTS), order state machine (V-ORDERS), admin handler
authz/step-up envelope detail (V-ADMIN — sampled only for boundary checks).

---

## Main-vs-branch flag (READ FIRST)

ADR-036 (cashback-token lifecycle: on-chain emission / redemption-burn /
on-chain interest-mint with off-chain mirror) is **NOT on main**. The doc and
all its code live only on the two feature branches:

| Feature                                                       | main            | branch                                                           | notes                                                  |
| ------------------------------------------------------------- | --------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `docs/adr/036-cashback-token-lifecycle.md`                    | absent          | both branches                                                    | branch-only                                            |
| `applyAdminEmission` (mint-without-debit)                     | **absent**      | both (`credits/emissions.ts`)                                    | main has only `withdrawals.ts` which debits            |
| Issuer-return **burn** when LOOP returns                      | **absent**      | both (`transitions.ts` `kind='burn'` payout + worker exec)       | genuinely implemented on branch, not stubbed           |
| **On-chain** interest mint                                    | **absent**      | `feat/wallet-phase-d-interest` only (`credits/interest-mint.ts`) | main interest is OFF-CHAIN ONLY                        |
| Off-chain interest accrual                                    | present + wired | (also present)                                                   | `accrue-interest.ts` LIVE on main, default-off (APY=0) |
| Off-chain cashback mirror + pending_payout                    | present         | present                                                          | `fulfillment.ts`                                       |
| `paymentMethod='loop_asset'` spend (off-chain debit, NO burn) | present         | branch adds burn-row alongside                                   | main: mirror debited but inbound LOOP not burned       |

Net for main: cashback and interest exist as an **off-chain ledger with a
forward-mint-pool reconciliation model** (drift watcher subtracts pool). The
on-chain half of the lifecycle (mint at emission, **burn at redemption**,
on-chain interest mint) does **not exist on main** — see P1-01.

---

## Probe results (the questions asked)

- **Double-entry invariant sum(tx)==balance.** Enforced structurally: every
  balance mutator (adjustments, refunds, withdrawals, compensation, accrue,
  fulfillment cashback, credit-order spend, loop_asset spend) writes the
  credit_transactions row and the user_credits delta in the **same** Drizzle
  txn under `SELECT … FOR UPDATE` on (user_id, currency). `ledger-invariant.ts`
  re-derives drift (pure + SQL) for the reconciliation endpoint and CLI.
  Sound. No writer found that touches one table without the other.
- **No money created/destroyed.** Cashback denomination is coherent:
  `repo.ts:124-128` calls `computeCashbackSplit` with **`requestedChargeMinor`**
  (home-currency charge), so `userCashbackMinor` is already in `chargeCurrency`;
  `fulfillment.ts:97-104` writes the ledger in `order.chargeCurrency`. No
  face-vs-charge unit mismatch. `applyPct` floors; residual lands in wholesale
  (Loop overpays CTX, never under) — correct direction.
- **At-most-once crediting.** Partial unique indexes are correct and layered:
  `credit_transactions_reference_unique` on `(type, reference_type, reference_id)`
  WHERE type IN (cashback, refund, spend, withdrawal); `_interest_period_unique`
  on `(user_id, currency, period_cursor)` WHERE type='interest'; `pending_payouts`
  `_order_unique` and `_active_withdrawal_unique`. `adjustment` deliberately
  excluded (idempotency at API via admin_idempotency_keys). Cause-chain walk to
  map 23505→409 is present in refunds + withdrawals.
- **Rounding / minor-units / bigint.** All money is `bigint` minor units or
  stroops; no float in any ledger path. `LOOP_ASSET_STROOPS_PER_MINOR=100_000n`
  guarded by `LOOP_ASSET_CODES` fail-loud (payout-builder.ts:126-134, A4-029).
  Interest math integer-only, floor (accrue-interest.ts:60-66). `recycledBps`
  clamps div-by-zero / overflow / negative.
- **Non-negative CHECK vs spend.** `user_credits_non_negative` CHECK + the
  in-txn `balance < amount → InsufficientBalanceError/InsufficientCreditError`
  pre-check exist on every debit path (adjustments, withdrawals, credit-order,
  loop_asset spend). loop_asset spend additionally throws
  `LoopAssetMissingCreditRowError` on a missing balance row rather than silently
  under-debiting (transitions.ts:94-104).
- **Concurrency / FOR UPDATE.** Correct everywhere checked. Daily admin-cap
  serialised by `pg_advisory_xact_lock` keyed on (scope,currency,UTC-day) —
  per-admin for adjustments, fleet-wide for compensation — closing the
  concurrent-sub-cap-drain race (adjustments.ts:114-115, payout-compensation.ts
  :170-191, A4-020). Period-cursor idempotency catches re-tick per-row and keeps
  going (accrue-interest.ts:183-201).
- **Cashback split sum ≤100 + audit trigger (ADR 011).** CHECK
  `merchant_cashback_configs_sum` is `<= 100` (under-capture allowed, matches
  ADR 011). History trigger `record_merchant_cashback_config_history` +
  `merchant_cashback_configs_audit` live in migrations 0000/0016/0029 (drizzle
  does not model triggers; schema.ts documents the manual-preserve contract).
- **Emission/redemption/burn lifecycle + mirror-debit (ADR 036).** Burn is
  **absent on main** (P1-01). On branch it is real and crash-consistent
  (debit + `kind='burn'` payout in one txn; worker exempts issuer-return from
  trustline probe). See P1-01 + branch concerns below.
- **Reconciliation off-chain↔on-chain.** `asset-drift-watcher.ts` computes
  `drift = onChain − pool − ledgerLiability×1e5`, notifies on transition only,
  fail-safe on Horizon blip. Recoverable (no permanent page). Branch adds
  in-flight-burn and in-flight-interest-mint terms so the mirror↔chain window is
  drift-neutral.
- **applyAdminEmission / burn implemented? interest on-chain?** Emission +
  burn + on-chain interest are branch-only. On main: emission path = the
  `withdrawals.ts` debit-at-send writer (ADR 024) which ADR 036 §Context calls
  the wrong model; burn = not implemented; interest = off-chain only.

---

## Findings

### [P1-01] Redemption burn / issuer-return is unimplemented on main — `loop_asset` spend debits the off-chain mirror but the returned LOOP is never burned

- **severity:** P1 (P0-adjacent on the divergence axis; rated P1 because the
  on-chain payout path that would mint user-held LOOP is itself not yet wired
  on main, so the over-issuance it would otherwise enable is latent)
- **file:** `apps/backend/src/orders/transitions.ts:62-139` (markOrderPaid,
  loop_asset branch) vs branch `origin/fix/adr036-emission-burn`
  `transitions.ts` (`kind='burn'` payout insert) — absent on main
- **impact:** ADR 036's core invariant is "the off-chain mirror is debited
  **only when tokens return**, and the returned LOOP is burned (issuer-return)
  so on-chain circulation drops in lockstep." On main, `markOrderPaid` for a
  `loop_asset` order correctly debits `user_credits` and writes the `spend`
  ledger row, but there is **no path that moves the received LOOP to the issuer
  to be burned**. The inbound LOOP-asset lands at the deposit/operator account
  and stays there. Once the cashback on-chain payout worker is enabled (it mints
  LOOP to users on fulfillment via `pending_payouts`), the steady-state is:
  Loop emits LOOP on-chain → user spends it back → off-chain mirror shrinks but
  on-chain circulation does NOT → `asset-drift-watcher` pages permanently and
  the issuer's outstanding liability is overstated. The branch fixes exactly
  this; until it merges, enabling on-chain cashback payout on main re-opens an
  over-circulation class.
- **evidence:** main `transitions.ts` loop_asset block ends at the balance
  decrement (line 134) with no `pending_payouts` burn insert; branch inserts a
  `kind='burn'` row to the issuer in the same txn and the worker burns it.
  `asset-drift-watcher.ts` has no in-flight-burn term on main.
- **fix:** merge `origin/fix/adr036-emission-burn` (burn-row + worker exemption
  - drift in-flight-burn term) before enabling the on-chain cashback payout
    worker on main; OR gate the on-chain cashback payout (`buildPayoutIntent` →
    `pending_payouts` insert in `fulfillment.ts:162-179`) behind a flag that is
    provably off until burn lands. Add a regression test asserting a loop_asset
    spend produces a matching burn intent.
- **ADR ref:** ADR 036 (lifecycle invariants c + redemption-burn).

### [P1-02] On-chain interest does not exist on main; off-chain accrual (if enabled) mints liability with no on-chain counterpart and relies entirely on manual pool pre-mint

- **severity:** P1 (latent — default APY=0 keeps it dormant)
- **file:** `apps/backend/src/credits/accrue-interest.ts` + `interest-scheduler.ts`
  (live on main, started in `index.ts:153-160`) vs branch
  `feat/wallet-phase-d-interest` `credits/interest-mint.ts` (on-chain + off-chain
  co-transactional) — absent on main
- **impact:** If an operator sets `INTEREST_APY_BASIS_POINTS > 0` on main, the
  scheduler credits `user_credits` (off-chain liability up) every UTC night with
  **no on-chain mint to the user**. The drift watcher only stays balanced if the
  operator has manually forward-minted into the interest pool account ahead of
  time (`drift = onChain − pool − ledger×1e5`; pool subtraction absorbs the
  accrued-but-not-distributed liability). There is no automation tying accrual
  volume to a pool top-up; `interest-forecast.ts` computes the needed mint but a
  human must act on it. The branch's `interest-mint.ts` makes both halves move
  in one txn and hard-fails the legacy off-chain-only scheduler at startup when
  `LOOP_INTEREST_ONCHAIN_ENABLED=true` to prevent double-write. On main no such
  guard exists; if the branch later merges without retiring the main scheduler,
  two interest writers could coexist.
- **evidence:** main `interest-scheduler.ts` is the only interest tick; it has
  no on-chain side. ADR 009 documents interest as "feature-flagged off until
  counsel confirms framing" — consistent, but the off-chain↔on-chain coupling is
  manual.
- **fix:** keep APY=0 on main until on-chain interest merges; document the
  manual pool-pre-mint dependency in the interest runbook; add the
  two-writers-must-not-coexist startup guard to main's scheduler now (cheap
  insurance) so a future merge can't double-credit.
- **ADR ref:** ADR 009 (interest), ADR 036 (interest as one op moving both halves).

### [P2-01] No test exercises the `merchant_cashback_configs_sum` / under-capture path nor the loop_asset double-spend invariant at the unit level for the spend ledger sign

- **severity:** P2
- **file:** `apps/backend/src/orders/cashback-split.ts` (computeCashbackSplit /
  applyPct) — tested only indirectly via `orders/__tests__/repo.test.ts`;
  loop_asset spend tested via `transitions.test.ts` + integration, but no direct
  assertion that a sum<100 config under-captures correctly into wholesale
- **impact:** `applyPct` parsing (the `numeric(5,2)`-string → hundredths bigint
  path, including the bare-integer branch and `padEnd(2,'0').slice(0,2)`
  truncation) is the money-math hot path and is only covered transitively. A
  regression in the decimal-truncation (e.g. "7.5" → 750 vs 705) would mis-pay
  every order and could pass the coarse repo test. The under-100 residual-to-
  wholesale path (ADR 011 deliberate under-capture) has no explicit assertion.
- **evidence:** `grep computeCashbackSplit|applyPct` over tests → only
  `repo.test.ts`; no `cashback-split.test.ts` exists despite 16 dedicated
  credits/**tests** files for sibling primitives.
- **fix:** add `orders/__tests__/cashback-split.test.ts` with table-driven cases
  for applyPct ("10.00","7.5","7","0","100.00","33.33") and a sum<100 config.

### [P2-02] `applyAdminCreditAdjustment` accepts `amountMinor = 0n`, writing a no-op ledger row that passes every CHECK

- **severity:** P2 (quality / audit-noise)
- **file:** `apps/backend/src/credits/adjustments.ts:95-145`
- **impact:** `amountMinor` is never validated `!= 0`. The sign CHECK permits
  `type='adjustment'` of any sign incl. zero; the cap check uses `|amount|=0`;
  `newBalance = prior + 0` passes non-negative. Result: an admin (or a buggy
  handler) can append zero-value adjustment rows that clutter the append-only
  ledger and the reconciliation/CSV surfaces with operator reasons attached but
  no effect. Refund and withdrawal both reject `<= 0`; adjustment is the
  inconsistent sibling.
- **evidence:** no `if (args.amountMinor === 0n)` guard; contrast refunds.ts:62
  and withdrawals.ts:95.
- **fix:** reject `amountMinor === 0n` with a typed error at the writer (or the
  handler) for parity with the other writers.

### [P2-03] Interest accrual `catch` matches the unique-violation by substring on the error message, not the structured pg code/constraint_name

- **severity:** P2 (robustness)
- **file:** `apps/backend/src/credits/accrue-interest.ts:189-201`
- **impact:** Refunds/withdrawals walk the DrizzleQueryError cause chain and
  match `code==='23505'` + `constraint_name`. Interest instead does
  `message.includes('credit_transactions_interest_period_unique') ||
message.includes('duplicate key value violates unique constraint')`. Message
  text is locale/driver-version dependent and the second clause is broad — a
  DIFFERENT unique violation (e.g. a future index) inside the txn would be
  mis-classified as "already accrued" and **silently skipped as success-ish**,
  masking a real write failure and under-crediting interest with no error.
- **evidence:** compare to the structured `isDuplicateRefund` /
  `isDuplicateWithdrawal` cause-chain walkers in the same vertical.
- **fix:** reuse the cause-chain code/constraint matcher; restrict to
  `constraint_name === 'credit_transactions_interest_period_unique'`.

### [P2-04] `markOrderFulfilled` peg-break (charge≠home currency) skips the on-chain payout but the off-chain cashback row is already committed — recovery is manual-only

- **severity:** P2
- **file:** `apps/backend/src/orders/fulfillment.ts:144-160` (A4-023)
- **impact:** When `order.chargeCurrency !== userRow.homeCurrency` (e.g. a
  support-mediated home-currency change after order placement), the cashback
  `credit_transactions` + `user_credits` rows write in chargeCurrency but the
  `pending_payouts` on-chain emission is skipped and a Discord page fires. The
  off-chain liability now exists in a currency that may have no configured
  issuer / no on-chain backing, and the only recovery is a human reading the
  alert and manually compensating. There is no skip-table / retry row capturing
  the intent — if the Discord notify is lost, the divergence is silent.
- **evidence:** `pegBreak` is captured + logged + notified post-commit; no
  durable row records the skipped on-chain side.
- **fix:** persist the peg-break to a durable table (or a `pending_payouts` row
  in a `needs_review` state) so recovery doesn't depend on an ephemeral Discord
  message; or block the home-currency change while the user holds an in-flight
  order.

### [P3-01] `resolveInterestPoolAccount` caches `null` permanently for the process when the operator secret is unset at first call

- **severity:** P3
- **file:** `apps/backend/src/credits/interest-pool.ts:42-67`
- **impact:** `cachedAccount` memoises the first resolution. If
  `LOOP_STELLAR_OPERATOR_SECRET` becomes available after first call (it won't
  at runtime — env is boot-fixed), or in tests across cases, the cache sticks.
  There is a `__resetInterestPoolForTests` seam, so this is test-only in
  practice and benign in prod (env is immutable post-boot). Noted for
  completeness; not a runtime defect.
- **fix:** none required; documented.

### [P3-02] `pendingPayoutsSummaryForUser` / forecast read the FULL `user_credits` aggregate with no statement bound; fine now, watch at scale

- **severity:** P3 (perf)
- **file:** `apps/backend/src/credits/interest-forecast.ts:84-90`,
  `liabilities.ts:18-25`
- **impact:** `SUM(balance_minor) GROUP BY currency` over the whole table on
  each forecast/drift tick. With ≤3 currencies and a small user base this is
  trivial; at scale it is a full-table aggregate per tick. No index helps a full
  SUM. Acceptable for Phase 1; flag for a materialised running-total if the
  drift watcher interval × user count grows.
- **fix:** none for Phase 1; consider a maintained per-currency liability total.

---

## Branch-code concerns (apply when ADR-036 branches merge — not main defects)

These are surfaced so the merge review carries them; they live on
`origin/fix/adr036-emission-burn` / `feat/wallet-phase-d-interest`:

- **Burn rows are operator-signed, not issuer-signed**, on the assumption that
  the redeemed LOOP lands in the deposit==operator account. Correct only while
  deposit and operator are the same account (ADR 010 topology note). A future
  split treasury would make the burn payment attempt to send from an account
  that doesn't hold the tokens. Needs an explicit assertion/test that
  operatorAccount == loop_asset deposit destination.
- **`applyAdminEmission` sanity-guard is not a reservation.** It checks
  `balance >= amount` under FOR UPDATE but never debits, and the unique index
  only fences _identical_ intents. Successive distinct emissions against the same
  liability are not collectively fenced → can mint unbacked LOOP; drift watcher
  catches after the fact, nothing blocks up-front.
- **`paymentMethod='credit'` (mirror-only debit, no token movement) remains
  live and is acknowledged-incoherent under ADR-036 open-question 3** — a user
  could redeem via `credit` the same balance whose on-chain LOOP still sits in
  their wallet (mirror/chain divergence the watcher pages on but doesn't
  prevent). Documented-but-unclosed.
- **No retro-mint for missed interest nights** — a midnight the worker missed is
  not back-filled; ops must notice the log and use admin-emission.

---

## Summary

The on-main credits/ledger code is **internally rigorous**: every balance
mutation is double-entry, transactional, FOR-UPDATE-locked, and idempotent via
well-targeted partial unique indexes; the daily admin-write cap is correctly
serialised with an advisory lock (incl. the fleet-wide compensation cap); money
is bigint-only with floor-toward-Loop rounding; the reconciliation invariant has
a pure + SQL definition and the drift watcher is recoverable. No money-creation
or at-most-once defect was found in the live writers.

The material risk is **completeness, not correctness**: the entire on-chain half
of ADR-036 — emission-mint, **redemption burn / issuer-return**, and on-chain
interest mint — is unmerged (branch-only). On main, off-chain cashback/interest
liability accrues against a manual forward-mint-pool reconciliation model, and a
`loop_asset` redemption debits the mirror without burning the returned token
(P1-01). These are dormant while the on-chain cashback payout worker and
interest (APY=0) stay off, but enabling either on main before the branches merge
re-opens an over-circulation / permanent-drift class. Plus four P2s (missing
direct cashback-split tests, zero-amount adjustment, substring-matched interest
idempotency, undurable peg-break recovery).

Severity counts: **P0 0 · P1 2 · P2 4 · P3 2** (+ 4 branch-merge concerns).
Files examined: **31** (28 in-scope + 3 cross-read) plus 6 branch-only files
inspected via git show.
