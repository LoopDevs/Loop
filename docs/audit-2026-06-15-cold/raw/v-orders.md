# V-ORDERS — Orders & Procurement vertical (cold audit 2026-06-15)

Branch `fix/stranded-order-hardening`. Adversarial cold read against code, not
docs/prior-audits. Scope: `apps/backend/src/orders/**`, `routes/orders.ts`,
web purchase flow (`apps/web/app/components/features/purchase/**`,
`services/orders*`). Cross-read `payments/watcher.ts`,
`payments/amount-sufficient.ts`, `db/schema.ts` order constraints.

---

## Probe results (the questions asked)

- **Can an order reach `fulfilled` without CTX paid (post-#1366)?** No, on the
  live code paths. `procureOne` calls `payCtxOrder` and only proceeds to
  `waitForRedemption` + `markOrderFulfilled` if it returns; every `payCtxOrder`
  throw class (`PayCtxConfigError`, `PayCtxReconcileError`, `PayoutSubmitError`,
  and the catch-all `throw err`) routes to `markOrderFailed`/rethrow → outer
  catch → `markOrderFailed`. `markOrderFulfilled` is structurally unreachable
  after a pay-ctx failure. Verified `procure-one.ts:220-307`. **The invariant
  holds but is NOT unit-tested at the procureOne level** — see [P2-01].
- **Pre-procurement payment gate.** Correct. The watcher (`watcher.ts:188-234`,
  `amount-sufficient.ts`) enforces asset/method match _and_ amount-sufficiency
  (charge-currency basis, oracle-backed) BEFORE `markOrderPaid`; procurement
  only selects `state='paid'`. Fail-closed on oracle outage.
- **Redemption-null path + backfill cap/alert.** Correct. `waitForRedemption`
  persists nulls on budget exhaust; `redemption-backfill.ts` sweeps with
  exp-backoff, hard cap (10), one-shot Discord page on cap-cross, pool-outage
  abort without burning attempts, idempotent state+still-NULL guarded write.
- **Stuck/expired sweeps.** Correct. `sweepStuckProcurement` cutoff 15 min >
  `waitForRedemption` 5-min budget, so it cannot race a live worker's redemption
  wait; state-guarded UPDATEs are no-ops against a live tick. Ambiguous-outcome
  per-row Discord alert present.
- **Extended-currency order rejection (ADR 035 gap).** Confirmed display-only:
  `loop-handler.ts:259-267` rejects any non-USD/GBP/EUR `currency`; `users`,
  `orders` charge/catalog currency CHECKs all pin to the 3 LOOP currencies. AE/IN/
  SA/AU/MX cannot place orders. Matches ADR 035's stated order-path gap.
- **PayCtxReconcileError + sep7 memo_type guard (recent change).** Correct and
  well-tested. `pay-ctx.ts` requires amount(stroops-normalised)+native-asset
  match on a memo+dest idempotency hit, else fail-closed reconcile throw;
  `sep7.ts` rejects non-text `memo_type`. Both have direct unit tests
  (`pay-ctx.test.ts`, `sep7.test.ts`). No defects found.

---

## Findings

### [P2-01] No unit test that a pay-ctx failure marks the order `failed`, never `fulfilled`

- **severity:** P2
- **file:** `apps/backend/src/orders/__tests__/procurement.test.ts` (whole suite) vs `apps/backend/src/orders/procure-one.ts:220-267`
- **impact:** The single most safety-critical invariant of the vertical
  (ADR 010: `fulfilled ⟹ CTX paid`) is enforced only by code structure with no
  regression test. The suite mocks `payCtxOrder` to always resolve
  (`procurement.test.ts:55-59`); there is no case where `payCtxOrder` rejects
  with `PayCtxConfigError` / `PayCtxReconcileError` / `PayoutSubmitError`, so a
  future refactor that (e.g.) moved `markOrderFulfilled` before the pay-ctx
  try/catch, or swallowed a reconcile throw, would pass CI green while
  re-opening the stranded-order / paid-but-unfulfilled class. The pay-ctx hop is
  exactly the bug class #1366 / the four 2026-05-14 stranded orders came from.
- **evidence:** `grep` of the test file shows `markFailedMock` asserted only for
  CTX-non-ok, schema-drift, and unexpected-throw — never for a pay-ctx reject.
  `payCtxOrderMock` has no `mockRejectedValue` anywhere.
- **fix:** Add three procureOne tests: `payCtxOrder` rejects with each error
  class → `r.failed===1`, `markFailedMock` called with the matching reason
  prefix, `markFulfilledMock` NOT called. Trivially expressible with the
  existing `payCtxOrderMock`.
- **ref:** ADR 010 (principal-switch pay-ctx; fulfilled⟹paid); checklist §12 (regression test for every fixed bug, esp. stranded-order/pay-ctx class).

### [P2-02] Post-pay-ctx failure marks order `failed` while CTX is already paid — no compensation/operator-debt surfacing

- **severity:** P2
- **file:** `apps/backend/src/orders/procure-one.ts:258-266, 279, 308-330`
- **impact:** After `payCtxOrder` succeeds (XLM/USDC has left the operator
  wallet to CTX), if `waitForRedemption` throws a terminal CTX rejection
  (`rejected`/`failed`/`error`) or the fetch throws, the outer catch calls
  `markOrderFailed(order.id, ...)`. The user sees `failed`, but Loop has _already
  paid CTX_ for that order. Unlike `sweepStuckProcurement` (which fires a
  per-row ambiguous-outcome Discord alert), this in-band failure path emits only
  a `log.error` — no Discord notify, no operator-debt / reconcile signal. Loop
  silently eats the wholesale cost with nothing paging ops to chase a refund
  from CTX. This is the same economic shape as the stranded-order class, just
  inverted (Loop-out-of-pocket instead of user-out-of-pocket).
- **evidence:** `procure-one.ts:308-330` outer catch → `markOrderFailed` with no
  notifier; contrast `transitions-sweeps.ts:83-93` which fires
  `notifyStuckProcurementSwept` per row precisely because the CTX-paid? question
  is ambiguous. Here we _know_ CTX was paid (payCtxOrder returned before the
  throw), so the ambiguity is resolved in the worst direction yet alerting is
  weaker.
- **fix:** Track whether `payCtxOrder` succeeded in `procureOne`; if a
  post-payment step then fails, fire a dedicated Discord alert
  (e.g. `notifyOrderFailedAfterCtxPaid`) carrying orderId/ctxOrderId/charge so
  ops can reconcile/refund. Optionally keep the order in a distinct terminal
  reason (`failed_after_ctx_paid`) rather than the generic failure string.
- **ref:** ADR 010; checklist §4 (error→observability, alerted if actionable), §17 (compensation, stuck-row recovery), §25 (settlement to CTX correctness).

### [P3-01] Legacy `POST /api/orders` does not reject disabled merchants

- **severity:** P3
- **file:** `apps/backend/src/orders/handler.ts:47-51`
- **impact:** The legacy CTX-proxy create handler checks only
  `merchantsById.get(merchantId) === undefined` (404), not `merchant.enabled`.
  The loop-native handler correctly rejects `enabled === false`
  (`loop-handler.ts:220`). A holder of a valid bearer can place a legacy order
  against a merchant the operator has explicitly disabled (e.g. evicted /
  quality-pulled per ADR 021), proxied straight to CTX. Low severity because the
  legacy path is being retired and CTX may itself reject, but it's an
  inconsistency with the loop-native gate and the eviction policy intent.
- **evidence:** `handler.ts:49` vs `loop-handler.ts:220` (`merchant.enabled === false`).
- **fix:** Add `|| merchant.enabled === false` to the legacy reject (or a 404 to
  avoid leaking disabled-merchant existence), matching loop-handler.
- **ref:** ADR 021 (eviction / public drop); checklist §1 (consistent patterns across siblings).

### [P3-02] `createOrder` on-chain path can throw raw `IdempotentOrderConflictError` past the credit-only catch — handled, but the wholesale-residual comment claims a non-existent guarantee

- **severity:** P3
- **file:** `apps/backend/src/orders/repo.ts:124-129, 19-29`
- **impact:** Minor doc/code drift, not a bug. The header comment (A4-018) states
  "Loop never over-quotes its own margin" and the residual always lands in
  wholesale. With `LOOP_PHASE_1_ONLY=true` (`repo.ts:153-156`) `userCashbackMinor`
  is zeroed and applied as an instant discount, so `chargeMinor =
requestedChargeMinor - split.userCashbackMinor`, but `wholesaleMinor` /
  `loopMarginMinor` are computed from `requestedChargeMinor` (pre-discount). The
  residual math in the comment is described against face value; under phase-1
  discount the row's `chargeMinor` can be < `wholesaleMinor + loopMarginMinor`
  for that order. The `orders_percentages_sum`/`non_negative` CHECKs still pass
  (they're on the pct + each amount individually, not chargeMinor ≥ wholesale+margin),
  so no constraint breaks, but the inline invariant narrative is stale for the
  phase-1 discount mode that is the _current_ production mode.
- **evidence:** `repo.ts:153-175` — `chargeMinor` derived post-discount while
  `wholesaleMinor`/`loopMarginMinor` come from the pre-discount `split`.
- **fix:** Update the A4-018 comment to document the phase-1 discount branch's
  effect on the residual relationship, or assert the intended relationship
  explicitly. No runtime change required.
- **ref:** checklist §5 (inline comments truthful), §25 (rounding/minor-unit).

### [P3-03] `loopListOrdersHandler` `before` pagination is non-strict on ties (potential skipped rows under same-millisecond createdAt)

- **severity:** P3
- **file:** `apps/backend/src/orders/loop-read-handlers.ts:167-178`
- **impact:** Pagination orders by `createdAt DESC` and pages with
  `lt(createdAt, before)`. `created_at` is `timestamptz` with default `now()`;
  two orders created in the same microsecond (rare but possible under burst /
  idempotent-replay double-submit) share a `createdAt`. A client passing the
  last row's `createdAt` as `before` would skip any sibling row with the
  identical timestamp (strict `lt` excludes equals; there's no `(createdAt, id)`
  tiebreaker). Low impact — bounded to ties, owner-scoped read only — but it's a
  silent data-completeness gap in a paginated financial list.
- **evidence:** `loop-read-handlers.ts:174` uses `lt(orders.createdAt, beforeDate)`
  with sole `orderBy(desc(orders.createdAt))`, no secondary sort key.
- **fix:** Add `id` as a tiebreaker to both the ORDER BY and the cursor
  predicate (keyset pagination on `(createdAt, id)`), or accept the documented
  edge as a known limitation.
- **ref:** checklist §3 (pagination, bounded results), §1 (boundary conditions).

### [P3-04] Kill switch not applied to loop-native order _create_ via middleware — relies on combined `orders-loop` only

- **severity:** P3 (verify — likely fine)
- **file:** `apps/backend/src/routes/orders.ts:74-79`
- **impact / status:** `POST /api/orders/loop` IS gated by
  `killSwitch('orders-loop')` and `POST /api/orders` by
  `killSwitch('orders-legacy')` — both create paths covered. The GET read
  handlers (`/api/orders/loop`, `/:id`) carry no kill switch, which is correct
  (reads are non-state-changing; AGENTS kill-switch list is orders/auth/
  withdrawals write paths). No defect; recorded to close the sweep item
  affirmatively. The per-path/combined fallback semantics (`LOOP_KILL_ORDERS`
  vs `LOOP_KILL_ORDERS_LOOP`) should be confirmed in `middleware/kill-switch.ts`
  (out of this vertical's file scope — flag for V14).
- **evidence:** `routes/orders.ts:68-98`.
- **fix:** None for orders vertical; cross-check kill-switch middleware fallback
  in V14.
- **ref:** ADR (A2-1907); checklist §27 (kill-switch coverage).

---

## Notes (verified-correct, no finding)

- **IDOR / authz on `:id`:** `loopGetOrderHandler` scopes the query to
  `(id, userId=auth.userId)` and 404s on miss (no existence leak). List is
  `userId`-scoped. Legacy `getOrderHandler` proxies by id with the user's bearer;
  CTX scopes by token (legacy proxy model) — acceptable for the retiring path.
- **Idempotency end-to-end:** web mints a stable UUID v4 key held across retries
  until success (`PurchaseContainer.tsx:325-347`, `orders-loop.ts:42-69`);
  backend lookup-first + partial-unique-index + cause-chain SQLSTATE match
  (`repo-idempotency.ts`, A4-026); CTX POST pinned with `Idempotency-Key=order.id`;
  Stellar pay-ctx idempotent via memo+dest+amount+asset find-outbound. No
  double-charge seam found.
- **bigint/money:** `formatMinorToMajor` (procure-one) and `decimalToStroops`
  (pay-ctx) are bigint-exact and tested past 2^53; no float money on the order
  path. `applyPct` integer-only. Web `formatMinor` is string-based.
- **credit method disabled (A4-110b):** `loop-handler.ts:318-331` rejects
  `paymentMethod='credit'` (double-spend prevention pending bucketing) — correct
  fail-closed. `markOrderPaid` loop_asset branch extinguishes off-chain liability
  under FOR UPDATE with missing-row throw (A4-110a) — correct.
- **Body-read-once / timeouts:** every upstream `fetch` carries
  `AbortSignal.timeout`; bodies read once (`res.text()` on !ok, `res.json()` on
  ok, never both). No "Body already read" risk.
- **Redaction:** redemption codes/PINs only logged when ALL-null
  (`procurement-redemption.ts:95-102`); never logged once populated. Order route
  is `private, no-store` with cache-control before requireAuth.

---

## Coverage — files examined (28 source + key tests + cross-reads)

orders/: barcode-fields.ts, cashback-split.ts, fulfillment.ts, get-handler.ts,
handler-shared.ts, handler.ts, list-handler.ts (re-export verified),
loop-create-checks.ts, loop-create-response.ts, loop-handler.ts,
loop-read-handlers.ts, loop-replay-response.ts, pay-ctx.ts, procure-one.ts,
procurement-asset-picker.ts, procurement-redemption.ts, procurement-worker.ts,
procurement.ts, redemption-backfill.ts, repo-credit-order.ts, repo-errors.ts
(read via repo), repo-idempotency.ts, repo.ts, request-schemas.ts, sep7.ts,
transitions-sweeps.ts, transitions.ts.
routes/: orders.ts.
tests: pay-ctx.test.ts, sep7.test.ts, procurement.test.ts (full),

- inventory of all 16 order test files.
  web: PurchaseContainer.tsx (handlePurchase), LoopPaymentStep.tsx,
  services/orders-loop.ts; inventory of PaymentStep/PurchaseComplete.
  cross-reads: payments/watcher.ts (markOrderPaid gate), payments/amount-sufficient.ts,
  db/schema.ts (orders constraints + idempotency unique index).

## Summary

- P0: 0
- P1: 0
- P2: 2 (untested fulfilled⟹paid invariant; failed-after-CTX-paid not alerted)
- P3: 4 (legacy disabled-merchant; stale residual comment; tie-pagination; kill-switch affirm)
- Total: 6

Launch posture for this vertical: **sound**. No money-loss / auth-bypass /
ledger-divergence defect found. The fulfilled⟹CTX-paid invariant holds in code;
the two P2s are a test-coverage gap on that invariant and a weak alerting path
when Loop-side debt is incurred (CTX paid, order failed). Both are pre-public-
traffic hardening items, not blockers.
