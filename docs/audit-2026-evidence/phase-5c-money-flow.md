# Phase 5c — Backend `orders/`, `payments/`, `credits/` (money-flow)

Commit SHA at audit: **450011ded294b638703a9ba59f4274a3ca5b7187** (branch `main`).

Scope: every file under `apps/backend/src/orders/`, `apps/backend/src/payments/`, `apps/backend/src/credits/` per plan §Phase 5. Financial-correctness concerns (plan §6.5) captured here rather than deferred — the ledger writers and state machines live in these three directories.

Method: §5.1 per-file + §5.2 per-endpoint, extended with an enumeration of state-machine transitions and a walk of every ledger/payout writer. Tests (`__tests__/`) consulted only to cross-check behaviour; the tests mock `db` end-to-end so they do not exercise SQL CHECK constraints or Postgres semantics (noted per-finding).

---

## 1. Order state-machine (`orders/transitions.ts`)

State enum (`apps/backend/src/db/schema.ts:408-411`):

```
pending_payment, paid, procuring, fulfilled, failed, expired
```

Authorised transitions — each is an `UPDATE ... WHERE state = <expected> RETURNING` so a duplicate/racy call returns null:

| From state                             | To state    | Function                             | Callers                          |
| -------------------------------------- | ----------- | ------------------------------------ | -------------------------------- |
| `pending_payment`                      | `paid`      | `markOrderPaid` (tx:42–57)           | `payments/watcher.ts:286`        |
| `paid`                                 | `procuring` | `markOrderProcuring` (tx:65–82)      | `orders/procurement.ts:192`      |
| `procuring`                            | `fulfilled` | `markOrderFulfilled` (tx:106–223)    | `orders/procurement.ts:277`      |
| `pending_payment`\|`paid`\|`procuring` | `failed`    | `markOrderFailed` (tx:240–253)       | `orders/procurement.ts:259, 315` |
| `pending_payment`                      | `expired`   | `sweepExpiredOrders` (tx:297–307)    | `payments/watcher.ts:358`        |
| `procuring`                            | `failed`    | `sweepStuckProcurement` (tx:283–295) | `orders/procurement.ts:389`      |

Non-allowed transitions (terminal states + skipped pairs) are implicitly rejected by the `WHERE` clause returning zero rows (caller receives `null`). There is **no positive reject-path test** per §Phase 5 requirement that "every non-allowed transition must have a reject path and a test" — `transitions.test.ts` covers the null-return for `markOrderPaid` and `markOrderProcuring` when their expected source state is missing, but does not enumerate the cartesian product (e.g. `markOrderProcuring` on an `expired` row; `markOrderFulfilled` on a `failed` row). See **A2-600**.

**Credit-payment gap (High/Critical — see A2-601):** `markOrderPaid` transitions state only. For orders with `paymentMethod='credit'` there is no debit against `user_credits` and no transition to `paid` anywhere in the codebase:

- `orders/loop-handler.ts:211-221` — checks `hasSufficientCredit` at order creation but writes the order in `pending_payment`.
- `payments/watcher.ts:75-79` — explicitly returns false for `credit` orders ("reaching this branch is a bug").
- Comment at `transitions.ts:37-40` claims a watcher-side credit debit exists; no such code is present (`grep type: 'spend'` returns zero call sites anywhere in `apps/backend/src`).
- Credit orders therefore sit in `pending_payment` for 24h and expire via `sweepExpiredOrders`.

`sweepStuckProcurement` does NOT roll back the cashback `credit_transactions` row or the `pending_payouts` row if the order actually reached `fulfilled` and only the ledger half crashed — but that's a non-issue because the fulfillment is already txn-bounded (see §3).

---

## 2. Payout state-machine (`pending_payouts`)

State enum (`apps/backend/src/db/schema.ts:565-568`):

```
pending, submitted, confirmed, failed
```

Transitions (`credits/pending-payouts.ts`):

| From state               | To state    | Function                                | Guard predicate                     |
| ------------------------ | ----------- | --------------------------------------- | ----------------------------------- |
| `pending`                | `submitted` | `markPayoutSubmitted` (166–182)         | `state='pending'`, bumps `attempts` |
| `submitted`              | `confirmed` | `markPayoutConfirmed` (188–204)         | `state='submitted'`                 |
| `pending` \| `submitted` | `failed`    | `markPayoutFailed` (217–233)            | `state IN ('pending','submitted')`  |
| `failed`                 | `pending`   | `resetPayoutToPending` (admin, 240–251) | `state='failed'`                    |

**Findings:**

- **A2-602 (Critical)** — `payout-worker.handleSubmitError` returns `'retriedLater'` on transient failures "under the attempts cap" and leaves the row in `submitted`. But `listPendingPayouts` (pending-payouts.ts:59–66) filters `state='pending'` only — rows in `submitted` are never re-picked. The row is orphaned and the retry never fires. Only outcome: `findOutboundPaymentByMemo` on some _future_ tick of another worker happens to pick the row, which it can't because the listing already filtered it out. This is a guaranteed stuck payout on any transient Horizon error.
- **A2-603 (High)** — No worker-level timeout / watchdog on `submitted` rows. A row stuck in `submitted` has no analogue to `sweepStuckProcurement`; the admin-only `resetPayoutToPending` only unsticks `failed` rows. Compounds A2-602.
- **A2-604 (Medium)** — `payout-submit.ts:112`: `timeout = args.timeoutSeconds ?? 60`. The `PayoutSubmitArgs.timeoutSeconds` is never passed by `payout-worker.payOne` (ca. line 138–149 of `payout-worker.ts`), so `setTimeout(60)` is always used. That's acceptable but the config surface is dead.
- **A2-605 (High)** — Memo collision: `orders/repo.ts:124-135` generates a 20-char base32 memo with 100 bits of entropy for on-chain payment orders. Independently, `credits/payout-builder.ts:87` uses `memoSeed.slice(0, 28)` of the **order UUID** for payout memos. These are two different memo spaces for two different directions (in vs out), both serving as the correlation key. Separate from A2-605 entropy, **they're unrelated memos**, so an inbound collision doesn't alias an outbound. But the inbound-memo `findPendingOrderByMemo` (`repo.ts:214`) looks up against the (unique-by-generated-memo) pending order, and `findOutboundPaymentByMemo` keys off the payout's order-id-prefix memo. The payout idempotency check can alias if two orders share the first 28 chars of their UUID. UUID v4 has ≈98 random bits in the first 36 chars; the first 28 chars are ≈21 hex chars = ~84 random bits — birthday-collision ≈ 2^-40 per pair (negligible at Loop scale). Still: memo should be independently generated for payouts, not sliced from the UUID.
- **A2-606 (Medium)** — Two-worker submit race between processes is resolved by the state-guard at `markPayoutSubmitted`, but both workers still execute the (slow) Horizon `findOutboundPaymentByMemo` pre-check first (payout-worker.ts:102-130), wasting Horizon quota. The loser reads Horizon → pre-check null → markSubmitted → null → skipRace.
- **A2-607 (Medium)** — `payout-worker.ts:102-108` passes `account: row.assetIssuer` to `findOutboundPaymentByMemo` with the explicit comment "invariant: the operator account IS the issuer for LOOP-branded assets". There is no enforcement of this invariant anywhere — a future ops change that splits operator from issuer breaks the pre-check silently and the worker double-submits on retry. ADR 016 calls for the pre-check to key on the operator pubkey derived from the secret (the TODO at line 99 acknowledges this).
- **A2-608 (Low)** — `resolvePayoutConfig` reads `process.env['LOOP_STELLAR_HORIZON_URL']` directly rather than via the `env` module (payout-worker.ts:283-287). Bypasses zod validation, breaks the env-var documentation promise.

---

## 3. `credit_transactions` writers (enumerated)

The following is the complete list of writers to `credit_transactions` in `apps/backend/src/**` (verified by grep `insert\(creditTransactions\)`):

| Writer                                                     | Type         | Sign     | Txn-bounded with balance update?                                                                 | Idempotency key                                                                                                                                                  | Finding        |
| ---------------------------------------------------------- | ------------ | -------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `orders/transitions.ts:136` (`markOrderFulfilled`)         | `cashback`   | positive | Yes — `db.transaction` wraps insert + `user_credits` upsert + `pending_payouts` insert (135–160) | State-guarded UPDATE on `orders` (state='procuring'). Second call returns null, ledger writes skipped.                                                           | A2-609         |
| `credits/accrue-interest.ts:96` (`accrueOnePeriod`)        | `interest`   | positive | Yes — `db.transaction` per user row                                                              | **None** — relies on external scheduler to run once per period (comment 58–62 acknowledges). No watcher-cursor wiring exists.                                    | A2-610, A2-611 |
| `credits/adjustments.ts:71` (`applyAdminCreditAdjustment`) | `adjustment` | signed   | Yes — `db.transaction` + `SELECT … FOR UPDATE` on `user_credits` row                             | Handled at admin HTTP layer via `admin_idempotency_keys`; the repo itself is NOT idempotent on replay. A direct caller bypassing the handler would double-write. | A2-612         |

Writers for `type='spend'`, `type='withdrawal'`, `type='refund'`: **none in the codebase.** See A2-601.

**Findings:**

- **A2-609 (Medium)** — `markOrderFulfilled` order of txn writes (transitions.ts:111-219): (1) UPDATE orders, (2) INSERT credit_transactions, (3) UPSERT user_credits, (4) SELECT user, (5) INSERT pending_payouts. All good under one txn. But the `SELECT … FROM users WHERE id` (170-176) does not use `FOR UPDATE` — if two fulfillment attempts race they'd both read the same user row, but only one wins the orders-state guard, so not a live race. OK.
- **A2-610 (Critical)** — `accrue-interest.ts:104-109`: the `tx.update(userCredits).set({balanceMinor: row.balanceMinor + accrual}).where(eq(userCredits.userId, row.userId))` predicate lacks the `currency` clause. A user with balances in two currencies (GBP row and USD row) would have BOTH rows bumped by `row.balanceMinor + accrual` — i.e. the other-currency row is overwritten with the wrong balance. **Multi-currency users are corrupted on every accrual.** Currently not scheduled (no interval loop wiring), so pre-launch no live exposure, but the code is shipped.
- **A2-611 (Critical)** — Related: `accrue-interest.ts:107` writes `row.balanceMinor + accrual` using the stale balance read BEFORE the tx — not a `SELECT … FOR UPDATE` inside the tx. A concurrent adjustment writer (`applyAdminCreditAdjustment`) that commits after the read can be silently overwritten. Lost-update bug. Again, not wired into a scheduler yet.
- **A2-612 (Medium)** — `applyAdminCreditAdjustment` uses `FOR UPDATE` correctly on the existing row (line 58-61) and recomputes `priorBalance + amountMinor` under the row lock. Good. But: the `credit_transactions_amount_sign` CHECK permits `type='adjustment'` with amount=0 (schema.ts:160 — `type = 'adjustment'` with no magnitude clause). `applyAdminCreditAdjustment` does not reject a zero-amount adjustment — a support-mediated no-op would still produce a ledger row with side-effects on reconciliation.
- **A2-613 (High)** — Ledger invariant `user_credits.balance_minor == SUM(credit_transactions.amount_minor) GROUP BY user_id, currency` has no DB-level enforcement. It holds by construction today (every writer is txn-bounded) but A2-610/A2-611 would violate it on first run with multi-currency users. There is also no online reconciliation — `admin/reconciliation.ts` exists (out of scope) but is a point-in-time SQL query, not a CI assertion.
- **A2-614 (High)** — No unique constraint on `(type, reference_type, reference_id)` in `credit_transactions`. The only idempotency guard for cashback writes is the `markOrderFulfilled` state-guard at the orders table. If a future writer inserts a `type='cashback'` row outside of `markOrderFulfilled`, double-writes are silently possible. ADR 009 envisions single-writer discipline but there's no DB enforcement.
- **A2-615 (Medium)** — `credit_transactions_amount_sign` CHECK does not constrain `type='adjustment'` magnitude or direction. Zero-amount adjustments permitted (A2-612). Not a correctness bug on its own but weakens the "sign convention enforced everywhere" invariant.

---

## 4. `pending_payouts` writers (enumerated)

Every insert or state update:

| Writer                                                        | Operation | Guard                                                       | Finding                                                                         |
| ------------------------------------------------------------- | --------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `orders/transitions.ts:201-211` (`markOrderFulfilled`)        | INSERT    | `onConflictDoNothing(orderId)` + UNIQUE index on `order_id` | A2-616                                                                          |
| `credits/pending-payouts.ts:34-53` (`insertPayout`)           | INSERT    | `onConflictDoNothing(orderId)` + UNIQUE index               | Dead code — not called from any production path (grep: only tests reference it) |
| `credits/pending-payouts.ts:171-182` (`markPayoutSubmitted`)  | UPDATE    | `state='pending'` + `attempts + 1`                          | A2-602 (state-trap noted above)                                                 |
| `credits/pending-payouts.ts:189-204` (`markPayoutConfirmed`)  | UPDATE    | `state='submitted'`                                         | —                                                                               |
| `credits/pending-payouts.ts:217-233` (`markPayoutFailed`)     | UPDATE    | `state IN ('pending','submitted')`                          | —                                                                               |
| `credits/pending-payouts.ts:240-251` (`resetPayoutToPending`) | UPDATE    | `state='failed'`                                            | Admin-only                                                                      |

- **A2-616 (Medium)** — Ledger/payout tx boundary is good (both inserts under the same `markOrderFulfilled` txn). BUT if `buildPayoutIntent` returns `kind='pay'` and the `user_credits` upsert succeeded, and the pending_payouts insert succeeded, and THEN the txn commits — good. If the user has no wallet (`stellarAddress === null`) the payout is skipped per ADR 015 — the cashback row is still in `user_credits`. The asset-drift watcher will then show a negative drift (liability > circulation) because the user can never "spend" the LOOP asset they never received. The drift is a correct signal, but it's indistinguishable from a drift caused by a real bug. Recommend: attach skip-reason metadata to a per-user queue so the operator can page a reminder.
- **A2-617 (Medium)** — `insertPayout` in `pending-payouts.ts:34-53` is the "clean" public API, but the production path in `markOrderFulfilled` (transitions.ts:200-211) inlines the insert without using it. Dead public API + duplicated column list (drift risk on a future schema change).

---

## 5. Currency-lock-in (FX pinning)

Per plan §6.5 G5-35: for a user with `home_currency='GBP'` buying a USD gift card:

1. Order creation at `orders/loop-handler.ts:192-206` calls `convertMinorUnits(amountMinor, currency, home_currency)` → `chargeMinor` in GBP pence.
2. `createOrder` (`orders/repo.ts:171-176`) pins `chargeMinor` + `chargeCurrency` on the row AND computes the cashback split against `chargeMinor` (NOT `faceValueMinor`).
3. Fulfillment (`transitions.ts:139-142`) writes `credit_transactions.currency = chargeCurrency` + `amount_minor = userCashbackMinor` (pinned at creation time).

The **FX rate itself** is not stored on the row — it is recoverable from `chargeMinor/faceValueMinor`. This is deterministic and idempotent for reconciliation purposes but has no audit row ("which rate did we commit to?"). `payments/price-feed.ts:45` uses a 60s cache — the rate at creation time is ephemeral.

- **A2-618 (Medium)** — No rate persistence. Post-incident reconstruction of "which FX rate did order X use?" requires reading `price-feed` caches (already gone). If a feed bug ever returned a corrupt rate the bad number persists only in the derived `chargeMinor`, which looks normal. Recommend: add an `orders.fx_rate_scaled BIGINT` column, populated when `chargeCurrency != currency`.
- **A2-619 (Critical)** — **User-visible amount vs watcher-expected amount mismatch for cross-currency XLM/USDC orders.** `orders/loop-handler.ts:338-347` returns `{amountMinor: order.chargeMinor.toString(), currency: order.chargeCurrency}` to the client — ie. for a GBP user buying a $50 USD card, the client sees "pay £39 worth of USDC". But `payments/watcher.ts:113-129` validates the USDC amount against `order.faceValueMinor * usdcStroopsPerCent(order.currency)` — ie. 5000 cents × USD rate. The client is told to pay GBP-equivalent, the watcher expects USD-equivalent. For the v1 same-currency case (chargeCurrency==currency) this is a no-op, but the divergence is shipped.
- **A2-620 (Low)** — `convertMinorUnits` rounds up (ceiling) "so the user's charge covers the catalog price after sub-cent rounding — Loop absorbs the one-minor-unit rounding in the user's favour on the procurement side" (price-feed.ts:231-234). The comment says "in the user's favour" but the math rounds UP (user pays more). Comment says the opposite of what the code does. Clarify.

---

## 6. Procurement worker (`orders/procurement.ts`)

Crash safety:

- **A2-621 (High)** — Line 192 `markOrderProcuring` flips state to `procuring`. Lines 242-254 call CTX. If the process crashes mid-CTX-call or immediately after, the row is in `procuring` with no `ctx_order_id`. The `sweepStuckProcurement` (383-395, 15-minute cutoff) fails the order. But CTX may have actually fulfilled the gift card on their side — a race between "CTX accepted and issued the card" and "procurement worker crashed before receiving the response" leaves CTX charged (for a real card) while Loop marks the order failed. No reconciliation path against CTX to recover the orphaned card. Pre-launch acceptable but listed.
- **A2-622 (High)** — `procureOne` does NOT wrap the CTX call + `markOrderFulfilled` in one transaction; they can't be (CTX call is HTTP). So the order is:
  1. markOrderProcuring (tx)
  2. CTX POST (HTTP, non-idempotent — CTX may double-bill on retry)
  3. fetchRedemption (HTTP)
  4. markOrderFulfilled (tx) — writes credit_transactions + user_credits + pending_payouts

  If (2) succeeds and the process crashes between (2) and (4), sweep marks `failed`. CTX is billed; no cashback row; no payout row. Loop is out of pocket; user is owed a refund that has no writer (no `type='refund'` writer exists anywhere).

- **A2-623 (Medium)** — `operatorFetch` (ctx/operator-pool) — not in scope for this phase but the `ctxOperatorId` audit tag is hardcoded to `'pool'` on line 192. Defeats the audit-trail purpose: you can never tell which operator actually served the order. ADR 013's audit-trail intent is unmet.
- **A2-624 (Medium)** — `fetchRedemption` returns `{code, pin, url}` without field validation of format / length. CTX returning a 10 MB code field would be persisted as-is into `orders.redeem_code` (no size cap in schema). Recommend bounded slice.
- **A2-625 (Low)** — `procureOne` on line 257 logs the first 500 chars of a non-ok CTX response. No pino redaction on `body` — if CTX ever echoes back sensitive data (gift card numbers, PII) it could leak to logs.

---

## 7. Payment watcher (`payments/watcher.ts`)

- **A2-626 (High)** — Cursor bookkeeping (writeCursor at lines 300-307) is a fire-and-forget write AFTER the transitions loop. If the loop crashes halfway through a page (say, on markOrderPaid row N of M), the cursor advances only if we complete the page and reach line 302. Half-processed pages are fully reprocessed on the next tick — which is fine for the IDEMPOTENT transitions, but: the `unmatchedMemo` and `skippedAmount` stats can double-count across retries. More importantly, if `writeCursor` throws (DB blip), the tick's mid-state is lost and the **same** page is reprocessed. Also fine. But: if `writeCursor` succeeds with a broken cursor (schema change), the ENTIRE future stream from that cursor is lost until admin intervention. No watchdog / no cursor-age alert.
- **A2-627 (Medium)** — `watcher.ts:286` calls `markOrderPaid` WITHOUT `paymentReceivedAt`. The transition defaults to `now` — correct in happy path but wrong for a backfill replay (e.g. after a Horizon outage the payments are hours old). Recommend passing `p.created_at` / `p.transaction.valid_after`.
- **A2-628 (Medium)** — `isAmountSufficient` USDC path (line 113-128) uses `order.currency`, not `order.chargeCurrency`. Combined with loop-handler.ts:338-347 returning `chargeMinor`, the user is told to send the GBP-equivalent of a USD-priced card while the watcher expects USD-equivalent USDC. See A2-619.
- **A2-629 (Low)** — Watcher uses Horizon native `/payments` endpoint via fetch() with `AbortSignal.timeout(10_000)` — fine. But `HorizonPayment.transaction.successful` is optional in the zod schema (horizon.ts:38-41) AND `transaction_successful` on the parent is optional (horizon.ts:54). The check `if (p.transaction_successful === false) continue` (line 237) misses the case where `transaction_successful` is undefined (schema drift). That's fine in the happy path but a newer Horizon response variant could flip unsuccessful txes to undefined and payments would be credited.
- **A2-630 (Low)** — `parseStroops` in both `watcher.ts:44` and `horizon-balances.ts:62` and `horizon-trustlines.ts:79` — three copies of the same logic. Divergence risk. Should live in a shared util.

---

## 8. Horizon clients (`payments/horizon*`, `price-feed.ts`)

All four Horizon callers (`horizon.ts`, `horizon-balances.ts`, `horizon-circulation.ts`, `horizon-trustlines.ts`) each:

- Read `process.env['LOOP_STELLAR_HORIZON_URL']` directly in a `horizonUrl()` helper — bypasses zod env validation.
- Use `AbortSignal.timeout(10_000)` — 10s timeout, consistent.
- Throw on non-2xx and on zod schema-drift. OK.

- **A2-631 (Medium)** — Four duplicated `horizonUrl()` helpers. A future URL change (e.g. to Stellar Expert) must edit four files. Consolidate.
- **A2-632 (Medium)** — `horizon-balances.ts:91-92`: `cached: Cached | null = null` is a single-entry cache. If the process reads two different accounts (unlikely in v1 but admin endpoints could) the second read evicts the first — not a correctness bug, just thrashing. `horizon-circulation.ts:72-73` has the same single-entry issue.
- **A2-633 (Medium)** — `horizon-circulation.ts:139`: `stroops = record === undefined ? 0n : amountToStroops(record.amount)`. The comment says "Circulation = total issued, net of what the issuer itself holds." But Horizon `/assets.amount` is the **total outstanding balance held by non-issuer accounts**, which IS the correct "circulation" figure per Stellar docs. The comment is accurate for the returned value; the variable naming could suggest it includes the issuer's own holdings, which it doesn't. OK but worth documenting.
- **A2-634 (Low)** — `horizon.ts:229-250` `isMatchingIncomingPayment` treats `p.transaction.memo_type !== 'text'` as reject — hash-memo payments are silently dropped. Documented but not tested: an attacker could pay with a `memo_hash` of the same bytes as the text memo and go undetected. Not a threat to Loop (their payment wouldn't match, but wouldn't credit either). Documented.
- **A2-635 (Medium)** — `payments/price-feed.ts:100-117` `stroopsPerCent`: `BigInt(Math.ceil(10_000_000 / minor))` — this converts JS number to BigInt but Math.ceil of a floating-point division can produce an off-by-one at extreme values. For XLM at $0.10, minor=10, 10_000_000/10 = 1_000_000 stroops per cent, exact. For implausibly high XLM prices (>$100) the result would still be integer. Acceptable but fragile — prefer integer division.
- **A2-636 (Low)** — `price-feed.ts:261`: `rateScaled = BigInt(Math.round(rate * Number(SCALE)))`. For Frankfurter rates like 0.7831 this rounds to `783100000n` — 9 decimal places of precision. Accurate to ~1e-9, well inside Loop's minor-unit resolution. OK.

---

## 9. Asset-drift watcher (`payments/asset-drift-watcher.ts`)

- **A2-637 (Medium)** — In-memory `assetState` (line 60) and `lastTickMs` (line 61) are process-local. Multi-instance deploy: each instance independently pages on transitions, so a single drift event pages N times (once per instance). Same class of bug as `notifiedFulfilled` in handler.ts:20.
- **A2-638 (Medium)** — `runAssetDriftTick` skips on Horizon failure (lines 120-130) **or** ledger-read failure (lines 131-138). If the ledger read fails persistently (DB outage), drift is never evaluated and operators may miss a real issue during the outage. Separately from the alert suppression, `skipped++` is a first-class metric but no alert fires on high skip rate.
- **A2-639 (Low)** — `notifyAssetDrift`/`notifyAssetDriftRecovered` fire on state transitions only (ok→over, over→ok), not on sustained drift. An operator who joins mid-incident won't see the paging. Accepted tradeoff per comment at lines 21-23, but worth noting.

---

## 10. Payouts asset layer (`credits/payout-asset.ts`, `credits/payout-builder.ts`)

- **A2-640 (Low)** — `payout-asset.ts:52-56` `payoutAssetFor` is pure but reads `env.*` at call time (via `issuerFor`). Acceptable for v1 env rotation — but it means hot-adding a `LOOP_STELLAR_EURLOOP_ISSUER` env does NOT take effect until restart (env is frozen at boot).
- **A2-641 (Info)** — `payout-builder.ts:69-90` is pure + well-tested. Clean separation of policy from submit.

---

## 11. Other concerns

- **A2-642 (Medium)** — Loop-handler `firstLoopAsset` check (`loop-handler.ts:245-246`) sends a Discord "first recycle" notification for the user. The check runs BEFORE the insert but is not transactional, and the Discord send is not idempotent. The comment at line 241-244 acknowledges a rare double-fire. Acceptable; documented.
- **A2-643 (Medium)** — Legacy (non-loop) `orders/handler.ts` creates orders directly against CTX, bypassing Loop's order state machine entirely. Those orders never reach `user_credits` — users don't earn cashback on the legacy path. The handler is still live (`POST /api/orders`). If a user places both legacy and loop-native orders, cashback history is fragmented across CTX (upstream aggregated) and Loop-DB. Clients can't reconcile the two.
- **A2-644 (Medium)** — `orders/handler.ts:306-312` `notifyOrderCreated` fires fire-and-forget on a bearer-token holder's `POST /api/orders`. No rate-limit on downstream (the webhook channel gets spammed by any authed client). AGENTS.md §Middleware rate-limits `POST /api/orders` at 10/min per IP; webhook spam is bounded by that.
- **A2-645 (Low)** — `orders/handler.ts:131-132` `ALLOWED_LIST_QUERY_PARAMS = {page, perPage, status}` — missing `limit` and other common params but that's by design per the comment. Good.
- **A2-646 (Low)** — `orders/handler.ts:74` `ORDER_EXPIRY_SECONDS = 30 * 60` is hardcoded. Loop-native orders use 24h expiry (watcher.ts:328). Legacy path's 30min expiry ≠ watcher's 24h sweep (legacy orders never hit the sweep; they're CTX-owned). Clients can show stale expiry but no financial impact.
- **A2-647 (Low)** — `orders/handler.ts:538-566` extracts gift-card numbers/pins by iterating over CTX response keys. String fields are not length-bounded before logging (line 556-566 logs the presence of fields but not their content — OK). The fields DO get stored on the Order row via… wait, they're written by `markOrderFulfilled` from `fetchRedemption`, not from this handler. Dead path: the legacy handler reads CTX response and does not persist to the Loop DB. OK.
- **A2-648 (Low)** — `orders/repo.ts:124-135` `generatePaymentMemo` alphabet indexing `byte % alphabet.length` — uint8 [0,255] mod 32 → unbiased (exactly 8 × 32 = 256). Good.
- **A2-649 (Info)** — No upstream zod schema is tagged explicitly `passthrough` vs `strict`. Per G4-17, this is needed for the financial surfaces: `GetOrderUpstreamResponse` (handler.ts:76-98) uses `.passthrough()` — explicit, fail-open to new fields. `CtxGiftCardResponse` (procurement.ts:46-48) is `z.object({id})` — strict-by-default, rejects new upstream fields that don't include `id`. Mixed policy, accept as current state.

---

## Findings summary

Finding IDs **A2-600 through A2-649** assigned monotonically. Severity breakdown:

- **Critical:** A2-601, A2-602, A2-610, A2-611, A2-619 (5)
- **High:** A2-603, A2-605 (downgrade after entropy analysis → Medium; keep High label per "label generously"), A2-613, A2-614, A2-621, A2-622, A2-626 (7)
- **Medium:** A2-600, A2-604, A2-606, A2-607, A2-609, A2-612, A2-615, A2-616, A2-617, A2-618, A2-623, A2-624, A2-627, A2-628, A2-631, A2-632, A2-633, A2-637, A2-638, A2-642, A2-643, A2-644 (22)
- **Low:** A2-608, A2-620, A2-625, A2-629, A2-630, A2-634, A2-635, A2-636, A2-639, A2-640, A2-645, A2-646, A2-647, A2-648 (14)
- **Info:** A2-641, A2-649 (2)

Total: 50 findings. A2-605 reclassified in inline text to Medium due to entropy analysis; tracker can adopt either label.

---

## Financial invariants — confirmation status

| Invariant                                                       | Confirmed at commit?                                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_credits.balance_minor >= 0`                               | Yes — DB CHECK (schema.ts:118) + `applyAdminCreditAdjustment` rolls back on violation                                                                          |
| `balance_minor == SUM(amount_minor) GROUP BY user_id, currency` | **Not** confirmed for active writers — A2-610 / A2-611 would violate for multi-currency users when interest accrual wires up. No DB-level enforcement.         |
| Sign convention (positive credit / negative debit)              | Partial — CHECK enforces for cashback/interest/refund/spend/withdrawal; `adjustment` is unconstrained (A2-615)                                                 |
| Money always BigInt-minor                                       | Yes within the loop-native path. Legacy `orders/handler.ts` uses JS `number` (parseMoney) — out of Loop-DB, CTX-only, acceptable since no ledger write happens |
| FX rate lock: where captured + persisted                        | Captured on order creation (`chargeMinor`), rate itself NOT persisted (A2-618)                                                                                 |
| Two concurrent payouts on same row                              | Protected by `markPayoutSubmitted` state-guard. Verified                                                                                                       |
| Procurement + ledger write atomic                               | **No** — CTX call sits BETWEEN `markOrderProcuring` and `markOrderFulfilled`. Crash-window exposes card-issued-without-credit (A2-622)                         |
| Cashback capture is single-writer                               | Yes by convention (markOrderFulfilled only). No DB uniqueness to enforce (A2-614)                                                                              |
| Credit-funded orders are properly debited                       | **No — credit payment path is not wired** (A2-601)                                                                                                             |

**Invariants I could not confirm:**

1. Ledger sum invariant against a prod-shaped dataset — requires running SQL per §6.5 method step 1. Out of this phase.
2. Interest-accrual idempotency across reruns — untestable; not scheduled anywhere yet (A2-611).
3. `accrue-interest.ts` against a real Postgres — all tests are mocked (A2-610 would be caught immediately by an integration test).
4. Memo collision bounds for real-world UUID distributions — back-of-envelope only (A2-605).

---

## Blockers

None for writing the evidence. Blockers for the fix phase (post-synthesis):

- A2-601, A2-610, A2-611, A2-619, A2-622 must be resolved before the Loop-native order flow carries real money. Each is a Critical.
- A2-602 must be resolved before the payout worker runs against mainnet — a single Horizon 503 strands every payout.
