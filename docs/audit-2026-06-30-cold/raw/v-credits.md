# Vertical Credits/ledger — raw findings

Files examined: 19/19 in explicit scope (all read in full) + 15/15 `__tests__`
siblings (all read in full) + targeted cross-reads required to verify the
CF-15/16/18/20/21 closure claims (listed in Coverage confirmation).

No in-scope file was unreadable; everything listed in the task brief was read
in full, including the "much-expanded" `refunds.test.ts` (472 lines).

---

## Findings

### V4-01 [P1 · LIVE] Auto-compensation can double-pay a withdrawal when the final retry is an ambiguous Horizon failure

- File: `apps/backend/src/payments/payout-worker-pay-one.ts:296-320` (`handleSubmitError`)
  interacting with `apps/backend/src/credits/payout-compensation.ts:91-247`
  (`applyAdminPayoutCompensation`, invoked via `autoCompensateFailedWithdrawal`
  at `payout-worker-pay-one.ts:365-420`). Root cause sits in `payments/` (V3),
  but the money-moving primitive it mis-fires is squarely `credits/` (V4) and
  this is exactly the CF-21 "auto-compensation completeness" question the
  brief asked me to chase — reporting it here per the cross-vertical
  interaction matrix (Part 3 item 5: withdrawal → payout worker → Stellar →
  compensation on fail).
- Description: `submitPayout` (`payments/payout-submit.ts:346-390`,
  `classifySubmitError`) classifies **any** error with no Horizon HTTP
  response (timeout, ECONNRESET, etc.) or a 5xx response as `transient_horizon`
  — explicitly an _ambiguous_ outcome: the tx may have actually landed and we
  simply lost the confirmation. CF-18 stamps the deterministic tx hash via
  `recordPayoutTxHash` (`pending-payouts-transitions.ts:95-105`) **before**
  the network submit, precisely so a later re-pick can ask Horizon
  authoritatively "did THIS hash land?" (`payout-worker-pay-one.ts:142-151`).
  That re-check correctly runs on every _subsequent_ pick. But when
  `usedAttempts >= maxAttempts` (`payout-worker-pay-one.ts:298-299`,
  default `LOOP_PAYOUT_MAX_ATTEMPTS=5`), `handleSubmitError` calls
  `markPayoutFailed` + `autoCompensateFailedWithdrawal` **immediately**, on
  the very attempt whose hash was just ambiguously left in doubt — without
  ever calling `getOutboundPaymentByTxHash` on that freshly-stamped hash
  first. Once the row is `failed` + `compensatedAt` is set,
  `resetPayoutToPending` refuses it (`compensatedAt IS NULL` guard,
  `pending-payouts-transitions.ts:163-180`) and `listClaimablePayouts` never
  selects `failed` rows again (`pending-payouts.ts:116-147`) — so nothing in
  the system will ever re-examine whether that final ambiguous tx actually
  landed.
- Impact: if the ambiguous final-attempt tx did land on-chain, Loop has now
  (a) sent the LOOP-asset on-chain to the user **and** (b) re-credited the
  user's off-chain balance for the same withdrawal via
  `applyAdminPayoutCompensation` — a silent double payment / direct fund loss
  with no automatic detection path short of the asset-drift watcher noticing
  a circulation/liability mismatch well after the fact, and even then nothing
  ties that drift back to this specific payout row for an automatic reversal.
  Reaching this state needs a sustained (~20-25 min at default
  `LOOP_PAYOUT_WATCHDOG_STALE_SECONDS=300`) run of ambiguous
  Horizon failures, which is a real, if uncommon, ops scenario (Horizon
  5xx storm, Fly egress flapping) rather than a purely theoretical one.
- Evidence:
  - `payout-submit.ts:346-357` — `transient_horizon` fires on "no response"
    or 5xx, both genuinely ambiguous about landing.
  - `payout-worker-pay-one.ts:226-239` — `onSigned` persists the hash via
    `recordPayoutTxHash` _before_ `submitTransaction`, so by the time the
    catch block runs the row's `txHash` already reflects this very attempt.
  - `payout-worker-pay-one.ts:296-308` — the exhausted-attempts branch calls
    `markPayoutFailed` directly; no `getOutboundPaymentByTxHash` call appears
    anywhere in `handleSubmitError`.
  - Test gap confirms the blind spot: `payments/__tests__/payout-worker.test.ts`
    has `'transient_rebuild at the attempts cap → markFailed'` (line ~546,
    safe — `transient_rebuild` only fires on a definitive synchronous
    Horizon rejection) but **no** equivalent `'transient_horizon at the
attempts cap'` test — the one ambiguous, risky case is untested.
  - `credits/__tests__/payout-compensation.test.ts` never exercises a
    payout row carrying a non-null `txHash`, i.e. the primitive's own test
    suite never probes "what if this failed payout was actually submitted."
- Minimal fix: in `handleSubmitError`, when `isTransient === true` and
  `usedAttempts >= maxAttempts` (i.e. about to terminally fail an
  _ambiguous_, not synchronously-rejected, error), perform one last
  `getOutboundPaymentByTxHash` check against the just-stamped hash before
  calling `markPayoutFailed`; if it landed, route through `convergeConfirmed`
  instead (skip compensation entirely). The hash is already known locally as
  `signedHash` inside `payOne`'s try block — thread it into
  `handleSubmitError` (or do the check inline in the `catch` before
  dispatching) rather than re-deriving it from a stale `row` snapshot.
- Better fix: add the same check as a defense-in-depth assertion inside
  `applyAdminPayoutCompensation` itself (`credits/payout-compensation.ts`),
  since that module is the actual fund-moving primitive and may grow
  additional callers later (e.g. a future admin "force-compensate" action).
  Have the worker pass the payout's `txHash` through to the compensation
  call and have the primitive refuse (or require an explicit
  `confirmedNotLanded: true` override) whenever `txHash !== null`, forcing
  every caller to prove non-landing before crediting back. This keeps the
  invariant enforced at the one place that actually writes the ledger row,
  not just at today's single call site.

### V4-02 [P3 · LIVE] `applyAdminRefund`'s `adminUserId` parameter is accepted but never used

- File: `apps/backend/src/credits/refunds.ts:139-152` (signature) vs. the
  function body (`refunds.ts:160-309`) — `args.adminUserId` is never read
  anywhere inside `applyAdminRefund`.
- Description: the docstring at the top of the file correctly explains that
  actor attribution lives in the API-boundary idempotency snapshot + Discord
  audit, not on the `credit_transactions` row — so this is _intentional_ —
  but the function still accepts `adminUserId: string` as a required
  parameter and silently drops it. `applyOrderAutoRefund` passes the literal
  `AUTO_REFUND_SYSTEM_ACTOR` string here as if it mattered.
- Impact: low — purely a readability/maintenance trap. A future contributor
  reading the call sites could reasonably assume `adminUserId` is persisted
  somewhere (it reads like an audit field) and build new logic on that false
  assumption (e.g. a future "refunds by admin X" report querying
  `credit_transactions` directly would silently return nothing, because the
  refund's actor is genuinely not there).
- Evidence: `grep -n adminUserId credits/refunds.ts` shows exactly two hits —
  the call site in `applyOrderAutoRefund` and the type signature — never an
  `args.adminUserId` read in the body.
- Minimal fix: add a one-line comment at the parameter declaration
  (`adminUserId: string, // intentionally unused — actor lives in the
idempotency snapshot + Discord audit, see applyAdminRefund's docstring`)
  so the gap reads as a documented decision, not an oversight.
- Better fix: drop the parameter from `applyAdminRefund`'s signature
  entirely (the docstring already explains where actor tracking lives) and
  have callers stop passing it; if a future ADR decides refunds need an
  on-row actor column, add it as a real schema field instead of resurrecting
  the dead parameter.

### V4-03 [P3 · LIVE] Stale docstring in `interest-pool.ts` contradicts its own (correct, tested) caching behaviour

- File: `apps/backend/src/credits/interest-pool.ts:18-23` (docstring) vs.
  `interest-pool.ts:31,42-43` (`cachedAccount` module-level memo).
- Description: the module docstring says "the helper re-derives on each call
  to keep the helper a pure read of env," but the implementation explicitly
  caches the resolved account in `cachedAccount` and only re-derives when
  `__resetInterestPoolForTests()` is called. The module's own test
  (`interest-pool.test.ts:60-69`, "caches the resolved value across calls
  within the same process") directly documents and relies on the opposite of
  what the docstring claims.
- Impact: low in practice (env is boot-fixed in production, so caching vs.
  re-deriving is behaviourally identical there) but it's a clean doc/code
  drift that will confuse the next reader trying to reason about whether a
  runtime env flip (e.g. a future hot-reload config path) would be picked up.
- Evidence: docstring lines 18-23 ("Pure-ish: the operator pubkey derivation
  calls into the Stellar SDK once per process... this module re-derives on
  each call to keep the helper a pure read of env") directly contradicts
  `let cachedAccount: string | null | undefined = undefined;` plus the
  early-return-if-cached logic at lines 42-43.
- Minimal fix: rewrite the docstring's "re-derives on each call" sentence to
  describe the actual behaviour (caches after first resolution; test seam
  `__resetInterestPoolForTests` exists for exactly this reason).
- Better fix: same text fix; no code change needed — the caching behaviour
  itself is correct and was already explicitly accepted as non-defective by
  the prior audit (06-15 P3-01).

### V4-04 [P2 · LIVE] `recordPayoutTxHash` and the admin single-row reads have no test against the real implementation

- File: `apps/backend/src/credits/pending-payouts-transitions.ts:95-105`
  (`recordPayoutTxHash`) and `apps/backend/src/credits/pending-payouts-admin.ts:59-80`
  (`getPayoutForAdmin`, `getPayoutByOrderId`).
- Description: `recordPayoutTxHash` is the CF-18 "authoritative tx-hash"
  stamping primitive — its entire safety property rests on the
  `WHERE state = 'submitted'` guard (only ever stamp a row this worker still
  owns). It has zero direct unit coverage: `payments/__tests__/payout-worker.test.ts`
  mocks it away completely (`vi.mock(...)` replaces the real implementation),
  and no integration test (`__tests__/integration/payout-worker.test.ts`)
  exercises it against real Postgres either — that suite covers
  `reclaimSubmittedPayout`'s CAS but not `recordPayoutTxHash`'s state guard.
  Similarly `getPayoutForAdmin` / `getPayoutByOrderId` (re-exported from
  `pending-payouts-admin.ts`) are only ever exercised through a fully-mocked
  admin-handler test (`admin/__tests__/payouts.test.ts`), never against the
  real Drizzle query — unlike their sibling `listPayoutsForAdmin`, which
  _does_ have a direct unit test in `pending-payouts.test.ts`.
- Impact: a regression that weakens `recordPayoutTxHash`'s state guard (e.g.
  accidentally allowing a stamp on a `pending` or `failed` row, not just
  `submitted`) would not be caught by any existing test, despite this being
  the load-bearing primitive for the CF-18 double-pay fix and directly
  adjacent to the V4-01 gap above. `getPayoutForAdmin`/`getPayoutByOrderId`
  regressions (e.g. an accidentally-dropped WHERE clause) are similarly
  invisible to the current suite.
- Evidence: `grep -rn recordPayoutTxHash apps/backend/src --include="*.ts" | grep -i test`
  returns only mock wiring inside `payout-worker.test.ts`, never a call into
  the real `pending-payouts-transitions.js` module from a test file.
- Minimal fix: add a focused unit test for `recordPayoutTxHash` mirroring the
  existing `pending-payouts.test.ts` chain-mock pattern (assert it writes
  `txHash` when `state='submitted'` and returns `null`/no-op otherwise), and
  add `getPayoutForAdmin`/`getPayoutByOrderId` cases to the same file
  alongside the existing `listPayoutsForAdmin` tests.
- Better fix: same, plus extend the real-Postgres integration suite
  (`__tests__/integration/payout-worker.test.ts`) with a case that stamps a
  hash, lets a second "instance" race a stamp on the same row, and asserts
  only the first wins — exercising the guard under real concurrency, not
  just a mocked WHERE clause.

### V4-05 [P3 · LIVE] `apy-snapshot.ts` is fully unwired — dead/orphaned primitive

- File: `apps/backend/src/credits/apy-snapshot.ts` (whole file: `computeAnnualisedRate`,
  `computePast30DayApy`).
- Description: neither export is imported anywhere in `apps/backend/src` or
  `apps/web/app` outside the module's own test file
  (`credits/__tests__/apy-snapshot.test.ts`). The module's own docstring says
  it's the "source-agnostic pure-function primitive" for ADR 031's "past
  30-day realised APY with disclaimer" UI, with "Callers (Track G UX) wire
  the source-side data fetch separately" — so this reads as deliberately
  pre-built scaffolding ahead of its consumer, not abandoned work, but as of
  this audit it is genuinely dead code on `main`.
- Impact: none today (no behavioural risk — it's inert), but it's worth
  tracking explicitly per the Part 5 "documented-but-unimplemented"
  completeness sweep so it doesn't silently bit-rot (e.g. drift out of sync
  with whatever vault share-price shape DeFindex actually returns) before
  its consumer lands.
- Evidence: `grep -rn "computeAnnualisedRate\|computePast30DayApy\|apy-snapshot"
apps/backend/src apps/web/app packages/shared/src` (excluding the module's
  own file and tests) returns zero hits.
- Minimal fix: none required if Track G (the consuming UI) is genuinely
  imminent; otherwise note explicitly in `docs/roadmap.md` / ADR 031 that
  this primitive is pre-built-and-waiting so a future dead-code sweep doesn't
  delete it by mistake.
- Better fix: when the DeFindex vault-share-price fetch (Track G) lands,
  wire this in immediately; until then, leave as-is — it's well-tested,
  small, and dependency-free, so the carrying cost is negligible.

---

## Carryover from the 06-15 audit (re-verified independently, not copied forward)

Checked AFTER forming my own findings above, per instructions. Status as of
this pass:

- **P1-01 (ADR-036 on-chain redemption burn absent on main)** — STILL OPEN,
  unchanged. `apps/backend/src/credits/` has no `emissions.ts`/burn module;
  `docs/adr/036-*.md` still absent from `main` (`ls docs/adr | grep 036` →
  empty), confirming the checklist's own note that ADR 036 still has no file
  on main. Out of this round's explicit file scope (orders/transitions.ts
  wasn't in my assigned list and wasn't touched by the delta), so not
  re-audited in depth — flagged only as still-present per a quick existence
  check.
- **P1-02 (on-chain interest mint absent on main)** — STILL OPEN, unchanged.
  No `interest-mint.ts` on main; `accrue-interest.ts`/`interest-scheduler.ts`
  remain off-chain-only, gated at `INTEREST_APY_BASIS_POINTS=0` by default.
  Not re-audited in depth this round (no delta touched the on-chain question).
- **P2-01 (no direct `cashback-split.ts` unit test)** — appears STILL OPEN
  (`find apps/backend/src/orders -iname "*cashback-split*"` finds only the
  source file, no test sibling) but `cashback-split.ts` is outside this
  round's explicit scope list — not independently re-verified beyond the
  file-existence check.
- **P2-02 (`applyAdminCreditAdjustment` accepts `amountMinor = 0n`)** — STILL
  OPEN, independently re-confirmed by direct re-read of
  `credits/adjustments.ts:95-145`: no `=== 0n` guard exists before the
  transaction; refunds and withdrawals both reject `<= 0` but adjustment
  still does not reject exactly `0`.
- **P2-03 (interest accrual unique-violation caught by message substring,
  not structured pg code)** — STILL OPEN, independently re-confirmed:
  `credits/accrue-interest.ts:190-193` still does
  `message.includes('credit_transactions_interest_period_unique') ||
message.includes('duplicate key value violates unique constraint')`
  rather than walking the cause chain for `code === '23505'` +
  `constraint_name`, unlike the structured walkers in `refunds.ts`
  (`isDuplicateRefund`) and `withdrawals.ts` (`isDuplicateWithdrawal`). The
  broad second substring clause means _any_ unique-violation surfacing
  inside that transaction (not just the interest-period one) is silently
  reclassified as "already accrued" and skipped rather than logged as a real
  failure.
- **P2-04 (peg-break recovery was alert-only, no durable row)** — **CLOSED**
  by CF-16 (`orders/fulfillment.ts:159-228`, this delta). The peg-break path
  now writes a durable `pending_payouts` row in the order's `chargeCurrency`
  whenever `buildPayoutIntent` returns `kind: 'pay'`, so the payout worker
  drives the on-chain side without depending on a human reading a Discord
  message. The remaining "no_address/no_issuer/no_cashback" skip case is
  alert-only, but that mirrors the identical non-peg-break skip behaviour
  elsewhere in the same function — not a residual peg-break-specific gap.
  Verified by direct re-read; see Delta re-verification below.
- **P3-01 (`resolveInterestPoolAccount` caches `null` permanently per
  process)** — prior audit correctly waved this off as a non-defect (env is
  boot-fixed in production). Still true. My independent V4-03 finding above
  is a narrower, distinct observation about the docstring text being wrong,
  not a re-flag of the caching behaviour itself.
- **P3-02 (full-table `SUM(balance_minor)` scan on every forecast/drift
  tick, no maintained running total)** — STILL OPEN, unchanged.
  `interest-forecast.ts:84-90` and `liabilities.ts:18-25` are both byte-for-
  byte the same shape as the prior audit's evidence. Low priority at current
  scale, as previously assessed.

---

## Delta re-verification

For each delta-manifest file in my scope, plus the specific CF-ids the brief
asked me to chase:

- **`credits/interest-scheduler.ts`** — no CF-id of its own in this delta
  (last touched 16 Jun per `ls -la`, but the diff is cosmetic/doc — the
  cross-instance safety story documented in the `tickInterestAccrual`
  docstring, citing CF-14, is accurate: the per-process `tickInFlight`
  boolean does NOT stop two Fly machines from both ticking the same UTC date,
  but the partial unique index on `(user_id, currency, period_cursor)` plus
  the per-user `FOR UPDATE` row lock genuinely close any double-accrual —
  traced through manually (two machines racing the same user/currency/cursor
  triple: the second machine's insert hits the unique constraint and is
  caught as `skippedAlreadyAccrued`, with the whole per-user transaction
  rolling back atomically on that throw, so no partial write survives).
  Verdict: **correct as documented**, no new issue found.
- **`credits/pending-payouts-transitions.ts`** — CF-18 (authoritative
  tx-hash payout idempotency). The five-transition split + `recordPayoutTxHash`
  addition is itself correct (state-guarded on `submitted`, returns `null`
  on a race rather than throwing). Verdict: **partially closed** — the
  primitive is sound and the _retry-path_ re-check (every re-pick checks the
  authoritative hash before resubmitting) works exactly as designed, but the
  _terminal/exhausted-attempts_ path in the caller
  (`payments/payout-worker-pay-one.ts`) never performs that same check
  before declaring failure + auto-compensating on an ambiguous
  `transient_horizon` error — see **V4-01**. Also flagged a test-coverage
  gap on the primitive itself (**V4-04**).
- **`credits/pending-payouts.ts`** — CF-14 (`FOR UPDATE SKIP LOCKED` on
  `listClaimablePayouts`). Re-read the full docstring + implementation:
  correctly scoped as a row-level claim (not full leader election, openly
  documented as such), correctly orders `pending` before stale `submitted`,
  correctly skips locked rows so concurrent Fly machines pull disjoint
  candidate sets. Verdict: **fully closed**, matches its own documented
  scope; no new issue found.
- **`credits/refunds.ts`** — CF-06 (order-validation + daily refund cap) and
  CF-20 (automatic order refund after CTX-paid failure). Independently
  traced both call sites of `applyAdminRefund`/`applyOrderAutoRefund`
  (`admin/refunds.ts` and `orders/procure-one.ts:autoRefundAfterCtxPaid`) —
  **both** route through the same validated primitive, so the
  ownership/currency/over-refund fences and the fleet-wide daily cap apply
  uniformly regardless of caller; CF-06's gap is closed everywhere
  `refunds.ts` is actually called from, not just the admin route the brief
  asked me to double-check. CF-20's auto-refund derives the amount from the
  order's own `chargeMinor`/`chargeCurrency` (read under the same `FOR
UPDATE` lock `applyAdminRefund` already takes), so the worker cannot
  over-refund or refund the wrong currency even though it supplies no human
  actor. Test coverage (`refunds.test.ts`) is genuinely comprehensive:
  order-not-found, IDOR (owner mismatch), currency mismatch, exact-charge
  boundary, over-refund, daily-cap under/over, and the CF-20 delegation +
  fence-reuse are all directly asserted. Verdict: **fully closed**, no new
  issue found.

CF-15 (`payments/payout-worker.ts`, withdrawal-only kill switch) and CF-16
(`orders/fulfillment.ts`, durable peg-break payout row) are outside my
explicit file scope but were named in the brief alongside CF-20/CF-21, so I
spot-checked both: CF-15 reads `isKilled('withdrawals')` once per tick and
only skips `kind='withdrawal'` rows, leaving order-cashback draining — matches
its docstring, **fully closed**. CF-16 writes a durable `pending_payouts` row
in the order's `chargeCurrency` whenever `buildPayoutIntent` can build one,
closing the prior audit's P2-04 — **fully closed**, see Carryover section
above.

---

## Coverage confirmation

In-scope files read in full (19):

- `apps/backend/src/credits/accrue-interest.ts`
- `apps/backend/src/credits/adjustments.ts`
- `apps/backend/src/credits/apy-snapshot.ts`
- `apps/backend/src/credits/interest-forecast.ts`
- `apps/backend/src/credits/interest-pool.ts`
- `apps/backend/src/credits/interest-scheduler.ts`
- `apps/backend/src/credits/ledger-invariant.ts`
- `apps/backend/src/credits/liabilities.ts`
- `apps/backend/src/credits/payout-asset.ts`
- `apps/backend/src/credits/payout-builder.ts`
- `apps/backend/src/credits/payout-compensation.ts`
- `apps/backend/src/credits/pending-payouts-admin.ts`
- `apps/backend/src/credits/pending-payouts-transitions.ts`
- `apps/backend/src/credits/pending-payouts-user.ts`
- `apps/backend/src/credits/pending-payouts.ts`
- `apps/backend/src/credits/refunds.ts`
- `apps/backend/src/credits/withdrawals.ts`
- `apps/backend/src/routes/users.ts`
- `apps/backend/src/users/cashback-history-handler.ts`

`__tests__` siblings read in full (15):

- `credits/__tests__/accrue-interest.test.ts`
- `credits/__tests__/adjustments.test.ts`
- `credits/__tests__/apy-snapshot.test.ts`
- `credits/__tests__/interest-forecast.test.ts`
- `credits/__tests__/interest-pool.test.ts`
- `credits/__tests__/interest-scheduler.test.ts`
- `credits/__tests__/ledger-invariant.test.ts`
- `credits/__tests__/liabilities.test.ts`
- `credits/__tests__/payout-asset.test.ts`
- `credits/__tests__/payout-builder.test.ts`
- `credits/__tests__/payout-compensation.test.ts`
- `credits/__tests__/pending-payouts-user.test.ts`
- `credits/__tests__/pending-payouts.test.ts`
- `credits/__tests__/refunds.test.ts`
- `credits/__tests__/withdrawals.test.ts`

Note: `pending-payouts-admin.ts` and `pending-payouts-transitions.ts` have no
dedicated `*.test.ts` sibling of their own — their exports are exercised
indirectly through `pending-payouts.test.ts` (re-exports) and mocked admin/
worker test suites. This gap is itself flagged as **V4-04**.

Targeted cross-reads (not full-file audits — used only to verify the
specific CF-id closure claims the brief asked about; full audit of these
files belongs to V2/V3/V8):

- `apps/backend/src/payments/payout-worker-pay-one.ts` (CF-18/CF-21 call site)
- `apps/backend/src/payments/payout-submit.ts` (`classifySubmitError`, the
  `transient_horizon` ambiguity source)
- `apps/backend/src/payments/payout-worker.ts` (CF-15 kill-switch read)
- `apps/backend/src/orders/fulfillment.ts` (CF-16 peg-break durable row)
- `apps/backend/src/orders/procure-one.ts` (CF-20 `autoRefundAfterCtxPaid`)
- `apps/backend/src/admin/refunds.ts`, `apps/backend/src/admin/withdrawals.ts`
  (the two admin handlers wrapping my in-scope writers — confirmed step-up
  gating + idempotency wiring at the route level via
  `apps/backend/src/routes/admin-credit-writes.ts`)
- `apps/backend/src/orders/repo-credit-order.ts` (the "spend via balance"
  debit path — non-negative CHECK vs. spend-path race check)
- `apps/backend/src/db/schema.ts` (`pendingPayouts`, `userCredits`,
  `creditTransactions` table definitions — CHECK constraints, indexes)
- `apps/backend/src/payments/__tests__/payout-worker.test.ts`,
  `apps/backend/src/__tests__/integration/payout-worker.test.ts`,
  `apps/backend/src/admin/__tests__/payout-compensation.test.ts`,
  `apps/backend/src/admin/__tests__/withdrawals.test.ts`,
  `apps/backend/src/admin/__tests__/payouts.test.ts` (test-coverage gap
  verification for V4-01/V4-04)
- `apps/backend/src/csv/csv-escape.ts` (the formula-injection guard
  `cashback-history-handler.ts`'s CSV export depends on)

No in-scope file was unreadable or skipped.
