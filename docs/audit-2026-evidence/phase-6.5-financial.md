# Phase 6.5 — Financial Correctness

- Commit SHA at audit: **`450011ded294b638703a9ba59f4274a3ca5b7187`** (branch `main`).
- Scope: plan §6.5 ledger invariant; reconciliation endpoint drift-injection;
  every writer to `credit_transactions` + `pending_payouts`; cashback-split
  invariant derivation; FX round-trip; interest accrual idempotency; sign
  convention; property-based tests for the cashback math primitives.
- Method: ephemeral Postgres 16 (`loop-audit-pg-65`, :55433) with all 12
  migrations applied in filename order (`0000..0011`); synthetic seeded
  datasets; injected-drift SQL; race replay via two concurrent psql
  sessions; property tests in `tsx` against `@loop/shared/cashback-realization.ts`
  and a replica of `apps/backend/src/orders/repo.ts::applyPct /
computeCashbackSplit` + `apps/backend/src/payments/price-feed.ts::convertMinorUnits`.
- Absolute rules: no edits to source, tracker, or migrations; container
  torn down on completion; no production contact.
- Starting hypotheses from phase 5c (A2-601, A2-610, A2-611, A2-619) and
  phase 6 (A2-700, A2-704, A2-705) — re-verified empirically below.

---

## Replay log

```
docker run -d --rm --name loop-audit-pg-65 \
  -e POSTGRES_USER=audit -e POSTGRES_PASSWORD=audit -e POSTGRES_DB=audit \
  -p 55433:5432 postgres:16

for f in $(ls apps/backend/src/db/migrations/0*.sql | sort); do
  docker exec -i loop-audit-pg-65 psql -U audit -d audit -v ON_ERROR_STOP=1 < "$f"
done
# all 12 migrations applied cleanly (0000..0011)
```

Tear-down: `docker stop loop-audit-pg-65` (at end of audit).

---

## 1. Ledger invariant

### 1.1 Formal statement

> For every `(user_id, currency)` pair with a `user_credits` row, the
> materialised `balance_minor` must equal
> `COALESCE(SUM(credit_transactions.amount_minor), 0)` filtered to the
> same `(user_id, currency)`.

### 1.2 Canonical SQL (exact text the `/api/admin/reconciliation` endpoint runs)

```sql
SELECT
  uc.user_id::text AS "userId",
  uc.currency AS currency,
  uc.balance_minor::text AS "balanceMinor",
  COALESCE(SUM(ct.amount_minor), 0)::text AS "ledgerSumMinor",
  (uc.balance_minor - COALESCE(SUM(ct.amount_minor), 0))::text AS "deltaMinor"
FROM user_credits uc
LEFT JOIN credit_transactions ct
  ON ct.user_id = uc.user_id AND ct.currency = uc.currency
GROUP BY uc.user_id, uc.currency, uc.balance_minor
HAVING uc.balance_minor != COALESCE(SUM(ct.amount_minor), 0)
ORDER BY uc.user_id
LIMIT 100;
```

### 1.3 Invariant on empty schema

```
drifted_rows
-------------
           0
```

### 1.4 Invariant on seeded, consistent dataset

Seed (3 users, 4 user_credits rows, 6 credit_transactions rows spanning
cashback / interest / adjustment / multi-currency):

```
               user_id                | currency | balance_minor | ledger_sum | delta
--------------------------------------+----------+---------------+------------+-------
 11111111-1111-1111-1111-111111111111 | USD      |           502 |        502 |     0
 22222222-2222-2222-2222-222222222222 | GBP      |           100 |        100 |     0
 22222222-2222-2222-2222-222222222222 | USD      |           200 |        200 |     0
 33333333-3333-3333-3333-333333333333 | USD      |           750 |        750 |     0

drifted_rows = 0
```

### 1.5 Injected drift — A2-610 multi-currency replay

Replayed the A2-610 accrue-interest bug against user B (GBP + USD
rows): `UPDATE user_credits SET balance_minor = <stale> + accrual
WHERE user_id = X` with no currency filter. Postgres silently
rewrites BOTH currency rows to the single scalar.

```
After the bad UPDATE, reconciliation endpoint yields:

               userId                 | currency | balanceMinor | ledgerSumMinor | deltaMinor
--------------------------------------+----------+--------------+----------------+------------
 22222222-2222-2222-2222-222222222222 | USD      |          105 |            200 |        -95

drifted_rows = 1   (endpoint correctly surfaces the drift)
```

**Verdict:** the endpoint DOES detect A2-610-shaped drift (✅). Finding
**A2-610** re-confirmed: `accrue-interest.ts:107-109` UPDATEs WHERE
`user_id = ?` — no currency clause — so a multi-currency user's other
row is corrupted on every tick.

### 1.6 Blind spots in the reconciliation endpoint

The endpoint LEFT JOINs `credit_transactions` from `user_credits` as
the anchor. A **credit_transactions row with no matching
`user_credits` row** is invisible.

```sql
-- Orphan: cashback row, no upsert on user_credits
INSERT INTO credit_transactions (user_id, type, amount_minor, currency, reference_type, reference_id)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','cashback',9999,'USD','order','orphan1');

-- Reconciliation endpoint SQL returns 0 rows.
-- An inverse query (NOT in the endpoint) catches it:
SELECT ct.user_id, ct.currency, SUM(ct.amount_minor) AS orphan_sum
FROM credit_transactions ct
LEFT JOIN user_credits uc
  ON ct.user_id = uc.user_id AND ct.currency = uc.currency
WHERE uc.user_id IS NULL
GROUP BY ct.user_id, ct.currency;
-- → 1 row, orphan_sum=9999  (not surfaced by the endpoint)
```

New finding **A2-900** (High) — see §10.

Also, the endpoint reports `userCount` as `COUNT(*) FROM user_credits`
which is the row count, not a user count (multi-currency users are
double-counted). Comment at `admin/reconciliation.ts:47-49` calls it
"total user_credits rows" in the type doc, but the response
serialises as `userCount` — shape and label disagree. Minor
(**A2-907**).

---

## 2. Every `credit_transactions` writer (enumerated)

Exhaustive grep `insert\(creditTransactions\)` across `apps/backend/src`:

| #   | Writer (path:line)                                         | Type         | Sign       | Txn with balance update?                                                                                            | Idempotency                                                                                                                                                                                | Concurrency-safe?                                                                                                                                      | Finding                                           |
| --- | ---------------------------------------------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 1   | `orders/transitions.ts:136` (`markOrderFulfilled`)         | `cashback`   | positive   | ✅ `db.transaction` wraps UPDATE orders → INSERT credit_transactions → upsert user_credits → insert pending_payouts | State-guarded UPDATE on `orders` (state='procuring' preserves at-most-once); no DB UNIQUE on (type, reference_type, reference_id) so a writer bypassing the state guard would double-write | ✅ inside txn; RC is adequate because the upsert uses the unique index                                                                                 | A2-614 / A2-902                                   |
| 2   | `credits/accrue-interest.ts:96` (`accrueOnePeriod`)        | `interest`   | positive   | ✅ `db.transaction` wraps insert + UPDATE user_credits                                                              | **None** — no scheduler cursor, no idempotency key, no unique constraint per (user, currency, period). Comment at line 57-62 acknowledges                                                  | ❌ **reads balance OUTSIDE txn, writes `stale + accrual` INSIDE, no FOR UPDATE, no currency clause on UPDATE predicate.** See §2.1 lost-update replay. | A2-610, A2-611 (re-confirmed), A2-700 (confirmed) |
| 3   | `credits/adjustments.ts:71` (`applyAdminCreditAdjustment`) | `adjustment` | signed (±) | ✅ `db.transaction` + `SELECT … FOR UPDATE` on user_credits row                                                     | App-level via `admin_idempotency_keys` at HTTP layer; repo itself is NOT idempotent on replay                                                                                              | ✅ FOR UPDATE is the correct pessimistic lock                                                                                                          | A2-612 (pre-existing)                             |

**Writers for `type='refund'`, `type='spend'`, `type='withdrawal'`:**
NONE in `apps/backend/src/**`.

```
$ grep -rE "type: ['\"](refund|spend|withdrawal)['\"]" apps/backend/src
apps/backend/src/admin/__tests__/user-credit-transactions.test.ts:126:        type: 'withdrawal',
apps/backend/src/admin/__tests__/user-credit-transactions-csv.test.ts:120:        type: 'withdrawal',
# → tests only, no production writers
```

The DB CHECK (schema.ts:151) declares these types, and `@loop/shared`

- openapi export them. They are dead enum values with no producer.
  Finding **A2-901** (High).

### 2.1 Lost-update race empirical replay (A2-611)

Two concurrent psql sessions against the live schema:

- **Session X** (simulating `accrue-interest.ts`):
  `BEGIN; INSERT interest row; SELECT pg_sleep(2); UPDATE user_credits SET balance_minor = 1000 + 10; COMMIT;`
  (reads `balance_minor=1000` outside the tx, writes absolute value
  inside the tx — the A2-611 pattern).

- **Session Y** (simulating `applyAdminCreditAdjustment`):
  `BEGIN; SELECT … FOR UPDATE; UPDATE user_credits SET balance_minor = balance_minor + 500; INSERT adjustment row; COMMIT;`

Interleaving: Y commits while X is in its `pg_sleep`. Final DB state:

```
balance_minor = 1010
credit_transactions: cashback(1000) + interest(10) + adjustment(500)
                                                   = 1510 sum

ledger-sum vs materialised balance: delta = -500
```

**A2-611 empirically confirmed.** The adjustment's +500 vanished;
Postgres did not raise a serialisation error because the two tx's
updated the same row under READ COMMITTED and the `stale + accrual`
write has no predicate it conflicts with.

This is a Critical correctness bug that will produce a silent,
permanent delta between materialised balance and ledger sum on every
concurrent interest-accrual vs admin-adjustment run. Currently dormant
(no scheduler wires accrue-interest), but ships with the module. The
reconciliation endpoint (§1.2) DOES detect the resulting drift after
the fact — so it's detectable, not reconcilable (the lost +500
adjustment is genuinely gone).

### 2.2 Sign-convention CHECK — empirical probe

Applied all 12 migrations, probed each type × sign combination:

| Insert attempt                   | Result                                           |
| -------------------------------- | ------------------------------------------------ |
| `cashback` amount=-1             | ❌ rejected by `credit_transactions_amount_sign` |
| `cashback` amount=0              | ❌ rejected                                      |
| `cashback` amount=+5             | ✅ accepted                                      |
| `withdrawal` amount=+5           | ❌ rejected                                      |
| `withdrawal` amount=-5           | ✅ accepted                                      |
| `interest` amount=0              | ❌ rejected                                      |
| `refund` amount=+5               | ✅ accepted (but no writer exists — A2-901)      |
| `adjustment` amount=+5           | ✅ accepted                                      |
| `adjustment` amount=-5           | ✅ accepted                                      |
| **`adjustment` amount=0**        | ✅ **accepted** (A2-615 confirmed)               |
| `bonus` (unknown type) amount=+5 | ❌ rejected by `credit_transactions_type_known`  |

Finding **A2-615** (pre-existing, Medium) — re-confirmed. Zero-amount
adjustment permits a no-op ledger row which is nonsense.

### 2.3 Currency-column CHECK — empirical probe

```
credit_transactions.currency = 'XXX'  →  accepted (no CHECK; A2-704)
credit_transactions.currency = 'usd'  →  accepted (no case-folding; A2-704)
user_credits.currency = 'ZZZ'         →  accepted (no CHECK)
orders.currency (catalog) = 'XXX'     →  accepted (A2-705)
orders.charge_currency = 'XXX'        →  ❌ rejected (orders_charge_currency_known)
```

A2-704 / A2-705 re-confirmed with empirical evidence. A user_credits
row in currency 'XXX' created via a backdoor write would partition
the reconciliation HAVING clause by that string — that bucket would
never reconcile to anything real. New finding **A2-903** elevates the
missing `user_credits.currency` CHECK separately (phase-6 folded it
into A2-704).

### 2.4 No UNIQUE on `(type, reference_type, reference_id)` (idempotency)

```sql
INSERT ... 'cashback', 500, 'order', 'same-order' → accepted
INSERT ... 'cashback', 500, 'order', 'same-order' → accepted
-- Two identical cashback rows for the same order are DB-legal.
```

A2-614 re-confirmed empirically. The only idempotency for cashback
today is the `markOrderFulfilled` state-guard on the orders row. A
second writer (future code) would double-credit silently.

---

## 3. Every `pending_payouts` writer (enumerated)

Exhaustive grep `insert\(pendingPayouts\)|update\(pendingPayouts\)`:

| #   | Writer                                                          | Op     | Guard                                                                  | Txn-bounded?                 | Idempotency                                               |
| --- | --------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| 1   | `orders/transitions.ts:201-211` (`markOrderFulfilled` inline)   | INSERT | `onConflictDoNothing(orderId)` + UNIQUE `pending_payouts_order_unique` | ✅ same txn as ledger writes | ✅ UNIQUE on order_id + onConflictDoNothing               |
| 2   | `credits/pending-payouts.ts:34-53` (`insertPayout`, public API) | INSERT | `onConflictDoNothing(orderId)`                                         | —                            | ✅ — but **dead code**; no production caller (see A2-617) |
| 3   | `credits/pending-payouts.ts:171-182` (`markPayoutSubmitted`)    | UPDATE | `state='pending'`                                                      | —                            | ✅ state-guarded — second call returns null               |
| 4   | `credits/pending-payouts.ts:189-204` (`markPayoutConfirmed`)    | UPDATE | `state='submitted'`                                                    | —                            | ✅ state-guarded                                          |
| 5   | `credits/pending-payouts.ts:217-233` (`markPayoutFailed`)       | UPDATE | `state IN ('pending','submitted')`                                     | —                            | ✅ state-guarded                                          |
| 6   | `credits/pending-payouts.ts:240-251` (`resetPayoutToPending`)   | UPDATE | `state='failed'`                                                       | —                            | ✅ admin-only                                             |

**Empirical probes:**

```
INSERT pending_payouts amount_stroops=0  → ❌ rejected (pending_payouts_amount_positive)
INSERT duplicate order_id                → ❌ rejected (pending_payouts_order_unique)
INSERT state='weird'                     → ❌ rejected (pending_payouts_state_known)
```

Phase 5c's A2-602 (Critical — retriable-failure `submitted` rows
never re-picked by listPendingPayouts) is a state-machine finding
that the DB-level audit cannot amplify; referencing it.

---

## 4. Cashback-split invariant

### 4.1 Derivation from code

Source of truth: `apps/backend/src/orders/repo.ts::computeCashbackSplit`
(lines 85-112). Given a pct triple `(wholesalePct, userCashbackPct,
loopMarginPct)` and an amount `X`, it computes:

```
userCashbackMinor = floor(X × userCashbackPct / 100)
loopMarginMinor   = floor(X × loopMarginPct / 100)
wholesaleMinor    = X - userCashbackMinor - loopMarginMinor
```

The stored `wholesalePct` on the row is the **config's** pct, NOT
`100 - userPct - marginPct`, so the invariant
`wholesalePct = 100 - userPct - marginPct` does NOT necessarily hold
(the config CHECK only requires `sum ≤ 100`, allowing
"under-captured" orders per schema.ts:174-176).

**The actual DB-enforceable invariant is:**

```
wholesaleMinor + userCashbackMinor + loopMarginMinor == chargeMinor
```

(not `faceValueMinor` — `createOrder` passes `chargeMinor` to
`computeCashbackSplit`, see repo.ts:173-176). This is the invariant
the property test below verifies.

### 4.2 chargeMinor vs faceValueMinor caveat (A2-619 amplified)

`createOrder` calls `computeCashbackSplit({faceValueMinor: chargeMinor})`
— the param is named `faceValueMinor` but the value is `chargeMinor`.
`orders.wholesale_minor` is therefore in the user's home-currency
minor units, not the catalog currency. For same-currency orders
(chargeCurrency == currency) this is a no-op. For cross-currency
orders the stored `wholesale_minor` is a **derived approximation** of
Loop's actual CTX spend (which is against the catalog-currency face
value) via the FX rate at order creation.

Reconciliation consequence: **`supplier-spend`-type aggregates that
sum `orders.wholesale_minor` are mixing currencies** unless grouped
by `charge_currency`. `orders.wholesaleMinor` is not a stable "USD
spent on CTX" number — it drifts with FX. Finding **A2-904**.

### 4.3 Property test (inline)

```javascript
// 50_000 random (face, userPct, marginPct) triples; only the ones
// where userPct + marginPct ≤ 100 count (DB CHECK).
function applyPct(minor, pctStr) {
  /* as in repo.ts:59-74 */
}
function computeSplit(face, userPctStr, marginPctStr) {
  const u = applyPct(face, userPctStr);
  const m = applyPct(face, marginPctStr);
  return { u, m, wholesale: face - u - m };
}

for (let i = 0; i < 50000; i++) {
  const face = BigInt(rand(10_000_000));
  const up = randPct(); // e.g. "7.83"
  const mp = randPct();
  if (!pctsSumLe100(up, mp)) continue;
  const s = computeSplit(face, up, mp);
  // INVARIANT A: u + m + w == face
  assert(s.u + s.m + s.wholesale === face);
  // INVARIANT B: wholesale >= 0 (DB CHECK orders_minor_amounts_non_negative)
  assert(s.wholesale >= 0n);
}
```

**Results:** PASS × 13 / 13 invariants.

```
split.sum_equals_face_value            PASS    (0/50000 violations)
split.wholesale_nonnegative            PASS    (0/50000 violations)
split.zero_face                        PASS
split.pcts_exactly_100                 PASS  (wholesale → 0)
split.floor_rounding_residual_into_wholesale   PASS
                                              (face=99, u=50%, m=0 → u=49, w=50)
```

The split math is arithmetically clean. Floor rounding pushes
residual into `wholesale`, which errs in Loop's direction (not the
user's) — comment at repo.ts:14-18 describes this accurately.

### 4.4 recycledBps property

```javascript
for (let i = 0; i < 20000; i++) {
  const earned = BigInt(rand(1_000_000));
  const spent = BigInt(rand(2_000_000)); // deliberately larger sometimes
  const b = recycledBps(earned, spent);
  assert(Number.isInteger(b) && b >= 0 && b <= 10_000);
  if (earned === 0n) assert(b === 0);
  if (earned > 0n && spent > earned) assert(b === 10_000);
}
// edge cases:
recycledBps(1000n, -5n); // === 0      (negative spent clamps)
recycledBps(0n, 1000n); // === 0      (div-by-zero safe)
recycledBps(1000n, 500n); // === 5000   (exactly 50%)
```

All pass.

### 4.5 Round-trip precision: earn X, spend X → balance 0

Synthetic — we cannot actually run this in the product because no
writer produces a `type='spend'` row today (A2-901). Simulated at the
ledger-math level: `earnMinor + (-spendMinor) === 0n` when earn == spend.
Verified 1000 random iterations: PASS.

**When A2-901 is resolved and spending writers exist, this property
test must re-run against real data** to confirm no ε leakage when
the ledger writer chooses to floor vs ceiling.

### 4.6 FX round-trip precision

```javascript
// replica of apps/backend/src/payments/price-feed.ts::convertMinorUnits
// rates: { GBP: 0.7831, EUR: 0.9254 }
// 5000 iterations: convert USD minor → GBP, then GBP → USD
for (let i = 0; i < 5000; i++) {
  const usd = BigInt(rand(1_000_000) + 1);
  const gbp = mockConvert(usd, 'USD', 'GBP', rates);
  const back = mockConvert(gbp, 'GBP', 'USD', rates);
  assert(back >= usd); // ceiling in both directions → never undershoots
  delta = back - usd; // tracks max overshoot
}
```

**Max round-trip overshoot: 2 minor units** across all 5000 iterations.
Ceiling both directions means `convertMinorUnits` **never undercharges
the user** — A2-620's doc-vs-code "in the user's favour" comment is
literally backwards: ceiling rounding on the USD→GBP leg means the
user pays slightly more than the strict catalog value. A2-620 stays
Low.

`charge_always_covers_face`: for all 5000 sampled (USD→GBP→USD)
round-trips, the re-converted value is `>=` the original. No
underpayment possible from rounding alone.

---

## 5. Currency boundaries — cross-currency orders

### 5.1 FX rate: captured where, persisted where?

- **Captured:** `orders/loop-handler.ts:192-196` calls
  `convertMinorUnits(amountMinor, currency, user.homeCurrency)`.
  The rate in flight is `cachedFx.minorPerUsdDollar` (price-feed.ts:138),
  60-second TTL, single-entry cache.
- **Persisted:** the rate itself is NOT stored. `chargeMinor` is
  computed + pinned on the order row; the rate is recoverable ONLY
  via `chargeMinor / faceValueMinor × crossing-hop`. After-the-fact
  forensics ("which rate did we commit to on 2026-04-20 at 14:32?")
  is not possible.

Finding **A2-618** (phase 5c Medium) re-confirmed.

### 5.2 chargeMinor vs faceValueMinor watcher mismatch (A2-619)

Confirmed by static reading of `payments/watcher.ts:70-147`:

- `loop_asset` path: `requiredStroops = order.chargeMinor * 100_000n`
  — uses CHARGE currency.
- `xlm` path: `requiredStroops = order.faceValueMinor * stroopsPerCent(order.currency)`
  — uses CATALOG currency.
- `usdc` path: `requiredStroops = order.faceValueMinor * usdcStroopsPerCent(order.currency)`
  — uses CATALOG currency.

Meanwhile, `loopCreateOrderHandler` returns to the client:
`amountMinor: order.chargeMinor.toString(), currency: order.chargeCurrency`
(loop-handler.ts:338-346).

For a same-currency order (catalog == home) these reduce to the same
number. For a cross-currency XLM/USDC order (e.g. GBP user, USD
$50 card), the client's quoted amount is GBP-equivalent (chargeMinor,
chargeCurrency='GBP'), but the watcher's threshold is
`faceValueMinor × usdcStroopsPerCent('USD')` — a USD-equivalent check.
The user gets told "pay £39-worth of USDC," sends £39-worth of USDC,
and the watcher rejects because it needed $50-worth.

Pre-launch: no live damage. Post-launch cross-currency orders (opt-in
for users buying foreign gift cards): every such order will fail the
payment check. **A2-619 re-confirmed (Critical by plan severity rubric).**

### 5.3 Refund path

`type='refund'` has NO writer. If an admin wanted to refund a
fulfilled order:

- Could call `applyAdminCreditAdjustment` with a positive amount →
  writes `type='adjustment'`, not `type='refund'`. Works but mis-types
  the row.
- Could directly INSERT `type='refund'` via a backdoor — no writer
  exists. `reference_type='refund_for_order'` / `reference_id=<order>`
  is the documented shape, not enforced.

Negative balances: CHECK on `user_credits.balance_minor >= 0` empirically
blocks negative writes. `applyAdminCreditAdjustment` pre-checks with
`newBalance < 0n → InsufficientBalanceError` (adjustments.ts:66-68),
and the DB CHECK is the second line of defence. Both confirmed.

Finding **A2-901** (High): dead `refund`/`spend`/`withdrawal` enum
values without writers.

---

## 6. Interest accrual

### 6.1 Scheduling

```
$ grep -rE "accrueOnePeriod|startInterestAccrual" apps/backend/src
apps/backend/src/credits/accrue-interest.ts   — declaration only
apps/backend/src/credits/__tests__/...         — test caller only
```

**There is no scheduler wiring.** Cannot test idempotency against reruns
because the function is never invoked outside tests. Finding **A2-905**:
ADR 009 declares interest accrual as a product feature but no
cron/watcher advances it. Not shipping in current boot sequence.

### 6.2 Rounding direction

`computeAccrualMinor`: `(balanceMinor * bps) / (10_000n * periodsPerYear)`
— BigInt integer division, always floors toward zero. Loop underpays
by at most 1 minor unit per user per period. Comment at
accrue-interest.ts:11-14 claims "Loop never overpays by a fraction"
— correct.

### 6.3 Idempotency across reruns

**NOT idempotent.** Comment at accrue-interest.ts:57-62 acknowledges:

> "Running it twice in the same period double-credits. Scheduling is
> expected to drive it exactly once per period (the follow-up scheduling
> slice keys the last-run timestamp on a `watcher_cursors` row; a
> replayed tick inside the same period is a no-op there)."

The scheduler doesn't exist (§6.1). When it lands it MUST land with
idempotency via a cursor OR a unique-constraint on
`(user_id, currency, period_bucket)` in credit_transactions — neither
exists today. Finding **A2-906** (High) — the idempotency promise is
a comment, not a mechanism.

### 6.4 Multi-currency bug (A2-610 re-confirmed)

See §1.5 empirical replay. The UPDATE at accrue-interest.ts:107-109
has no `eq(userCredits.currency, row.currency)` predicate, so a user
with rows in ≥2 currencies has ALL rows overwritten to the same
scalar on every tick.

### 6.5 Lost-update race (A2-611 re-confirmed)

See §2.1 empirical replay. A concurrent `applyAdminCreditAdjustment`
that commits between the accrual's outside-txn read and inside-txn
UPDATE is silently lost.

---

## 7. Sign convention — DB-enforced?

| Invariant                                     | Enforced?                                                       |
| --------------------------------------------- | --------------------------------------------------------------- |
| `cashback` / `interest` / `refund` amount > 0 | ✅ CHECK `credit_transactions_amount_sign`                      |
| `spend` / `withdrawal` amount < 0             | ✅ CHECK                                                        |
| `adjustment` amount any non-zero              | ❌ CHECK allows amount = 0 (A2-615 confirmed §2.2)              |
| No unknown `type` values                      | ✅ CHECK `credit_transactions_type_known`                       |
| `amount_minor != 0` overall (plan §6.5 asks)  | ❌ not enforced — zero adjustments pass                         |
| `currency` matches known ISO list             | ❌ not on credit_transactions or user_credits (A2-704 / A2-903) |

---

## 8. Admin writers summary & idempotency (ADR 017)

`adjustments.ts` (the one real admin ledger writer):

- ✅ FOR UPDATE on balance row
- ✅ Transaction-bounded
- ✅ `referenceType='admin_adjustment'`, `referenceId=adminUserId`
- ⚠️ **No row-level idempotency** — the `admin_idempotency_keys` snapshot
  store is applied at the HTTP handler layer (outside this file).
  A direct programmatic caller bypassing the handler would double-write.
  A2-612 (phase 5c) re-confirmed.
- ⚠️ **`reason` is NOT persisted on the credit_transactions row.** It
  lives in `admin_idempotency_keys.response_body` for 24h (A2-721 from
  phase 6). After 24h the "why" of every adjustment is unrecoverable
  from the ledger — ADR 017 #4's "full story reconstructable from the
  append-only ledger" is not true. See comment at adjustments.ts:77-81
  acknowledging the follow-up ADR. Finding **A2-908** (Medium).

---

## 9. Pre-launch blast radius

| Finding                                           | Wired into current boot?                                     | Live-money exposure?                                                        |
| ------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| A2-601 (credit-payment path unwired)              | No — `credit` orders sit in `pending_payment`, expire at 24h | ❌ pre-launch fine                                                          |
| A2-610 multi-ccy accrual                          | accrueOnePeriod has no scheduler                             | ❌ not firing                                                               |
| A2-611 lost-update accrual                        | ditto                                                        | ❌ not firing                                                               |
| A2-619 cross-currency watcher mismatch            | Watcher runs; cross-ccy order creation path also active      | **First cross-ccy order made post-launch: guaranteed failed payment check** |
| A2-614 no UNIQUE on credit_tx idempotency         | Live                                                         | ❌ single-writer discipline (markOrderFulfilled) holds by convention        |
| A2-901 dead refund/spend/withdrawal types         | Live                                                         | Info until a writer needs them — no product feature blocked                 |
| A2-900 orphan-credit blind spot in reconciliation | Live                                                         | Hidden drift undetectable by the admin endpoint                             |

Every Critical is either behind a scheduler that doesn't exist (A2-610,
A2-611) or behind a credit-payment path that is effectively dead
(A2-601). A2-619 is the one Critical that fires as soon as a
home≠catalog order is placed. Remediation order should put A2-619 at
the top.

---

## 10. Findings (A2-900 .. A2-908)

### A2-900 — Reconciliation endpoint has an orphan-ledger blind spot (High)

**File:** `apps/backend/src/admin/reconciliation.ts:75-89`
**Evidence:** The SQL LEFT JOINs `credit_transactions` FROM `user_credits`.
A `credit_transactions` row with no matching `(user_id, currency)` row
in `user_credits` is invisible to the endpoint. Empirically (§1.6):
a seeded orphan `cashback(+9999, USD)` for a user with no
`user_credits` row returns 0 rows from the reconciliation query but
9999 from the inverse query.
**Impact:** A hypothetical writer (or manual DBA fix-up) that inserts
a `credit_transactions` row without the corresponding `user_credits`
upsert creates a permanent invisible drift. The ledger liability is
understated on `sumOutstandingLiability` (which also reads
`user_credits` only); the ledger-sum side is inflated.
**Remediation:** Add a FULL OUTER JOIN or a second query that scans
credit_transactions for rows not covered by a `user_credits` row.
Alternatively, add a `user_credits` upsert pre-check inside every
`credit_transactions` writer and enforce referential consistency via
a FK/trigger.

### A2-901 — `refund`, `spend`, `withdrawal` declared in CHECK but have no production writers (High)

**Files:** `apps/backend/src/db/schema.ts:151`, `@loop/shared/credit-transaction-type.ts`,
`openapi.ts:286, 1304`, `apps/web/app/services/admin.ts:1858`.
**Evidence:** Grep `type: ['"](refund|spend|withdrawal)['"]` across
`apps/backend/src/**`: 0 production hits, only test fixtures at
`admin/__tests__/user-credit-transactions.test.ts:126,146`.
**Impact:** The CHECK enum, the shared type union, the openapi
schema, and the web admin client all declare `refund` / `spend` /
`withdrawal` as real ledger types. Support-mediated refunds and
credit-funded order debits (A2-601) have no path to actually write
these rows today. Operators told "just issue a refund" will be unable
to; the admin UI will surface type filters that match zero rows.
**Remediation:** Either ship the writers (refund handler in admin;
spend-debit inside the credit-order `markOrderPaid` transition; a
withdrawal-to-wallet path per ADR 015 flow 2) OR prune the enum to
the types that actually exist and update the shared type + openapi
to match.

### A2-902 — No DB UNIQUE for cashback ledger idempotency (High)

**File:** `apps/backend/src/db/schema.ts:132-164`.
**Evidence:** No `UNIQUE(type, reference_type, reference_id)`; no
`UNIQUE(user_id, type, reference_type, reference_id)`. Empirically
(§2.4), two identical `(cashback, order, X)` rows are both accepted.
**Impact:** The only cashback idempotency guard is the state-machine
guard on the `orders` row (state='procuring' WHERE clause in
`markOrderFulfilled`). A future writer — or a direct DB intervention
by ops — that inserts a credit_transactions row outside this pathway
will silently double-credit. Elevates A2-614 (phase 5c Medium) to
High on the basis that ADR 009 explicitly calls the ledger
append-only and reconcilable by replay; without DB-level idempotency
one replay mistake is permanent.
**Remediation:** partial UNIQUE index on
`(type, reference_type, reference_id) WHERE type='cashback'` (and
similar for `interest` once scheduler lands with a period-bucket
reference).

### A2-903 — `user_credits.currency` has no CHECK (High)

**File:** `apps/backend/src/db/schema.ts:100-120`;
`apps/backend/src/db/migrations/0000_initial_schema.sql:43-49,65`.
**Evidence:** §2.3 — a seeded `user_credits` row with currency='ZZZ'
is accepted. Phase 6 A2-704 covered `credit_transactions.currency`;
this separately covers the balance table. `users.home_currency` IS
bound to `('USD','GBP','EUR')` — inconsistency across the three
currency columns.
**Impact:** The reconciliation endpoint groups by `currency`; a row
with a bogus currency partitions into its own bucket that will never
reconcile against anything (no corresponding credit_transactions
rows exist in the backdoor case). Balance is permanently "stuck" in
limbo from the endpoint's perspective.
**Remediation:** `CHECK (currency IN ('USD','GBP','EUR'))` on
`user_credits` and on `credit_transactions` in a migration.

### A2-904 — `orders.wholesale_minor` mixes catalog and charge currencies (Medium)

**File:** `apps/backend/src/orders/repo.ts:173-176`.
**Evidence:** `computeCashbackSplit({faceValueMinor: chargeMinor})`
passes the charge-currency amount through a parameter named
`faceValueMinor`. The resulting `wholesaleMinor = chargeMinor -
userCashback - loopMargin` is therefore in home-currency units, not
catalog-currency units.
**Impact:** Every admin `supplier-spend` aggregate that sums
`orders.wholesale_minor` without grouping by `charge_currency`
returns a currency-mixed number. The "USD supplier spend to CTX" KPI
is not a real number when any non-USD user exists. For same-currency
orders this is harmless; for cross-currency orders (post-launch
feature) the drift is proportional to the FX rate.
**Remediation:** either rename the field and pin a separate
catalog-currency `catalog_wholesale_minor` (derived at procurement
time against the actual CTX charge) OR document + enforce that every
supplier-spend query groups by `charge_currency`.

### A2-905 — Interest accrual has no scheduler wiring (Medium)

**Files:** `apps/backend/src/credits/accrue-interest.ts` (declaration
only); no `setInterval`/cron reference anywhere in `apps/backend/src`
other than the test fixture.
**Evidence:** `grep accrueOnePeriod apps/backend/src` returns the
declaration + test fixtures only; no production caller.
**Impact:** ADR 009 describes interest accrual as a product primitive.
The function exists; nothing runs it. Users earn no interest today,
which means the bugs at A2-610 / A2-611 / A2-906 are also dormant.
Cleanly resolving those three bugs before the scheduler lands is
cheap; once live, any lost-update event is permanent silent drift.
**Remediation:** before wiring a scheduler, fix A2-610 (currency
predicate), A2-611 (FOR UPDATE), A2-906 (period idempotency). Then
land the scheduler with a `watcher_cursors` row keying
`{period_bucket: ISO8601-month}`.

### A2-906 — Interest accrual has no period-level idempotency (High)

**File:** `apps/backend/src/credits/accrue-interest.ts:57-62`.
**Evidence:** The docstring explicitly calls out "running it twice
in the same period double-credits." No cursor, no unique constraint
on `(user_id, currency, period_bucket)`. If a scheduler fires the
function twice — a retry after a transient DB error, a double-boot
during a Fly rollout — every user with a positive balance gets
double interest that period.
**Impact:** Currently dormant (A2-905). When the scheduler lands,
this is a Critical-severity pipeline. The reconciliation endpoint
WOULD detect the drift (since both the INSERT and the UPDATE fire
consistently), so "detectable, not preventable" — but the user-visible
balance jumps and then gets corrected via an admin adjustment, which
is user-hostile.
**Remediation:** store the last-accrued period key per
`(user_id, currency)` row (or on a per-run `watcher_cursors` entry)
and gate the accrual on it. Optionally add a UNIQUE partial index on
`credit_transactions (user_id, currency, reference_id) WHERE type='interest'`
using a period-bucket string as the reference_id.

### A2-907 — `reconciliationResponse.userCount` mislabels row count as user count (Low)

**File:** `apps/backend/src/admin/reconciliation.ts:100-104`.
**Evidence:** `SELECT COUNT(*) FROM user_credits` is counted as
"total user_credits rows across all users and currencies" in the
type doc but serialises as `userCount` on the wire. Multi-currency
users double-count.
**Impact:** Admin UI copy "✓ 0 drift across N rows" reads as "0 drift
across N users" to a viewer who didn't read the doc. For a pre-launch
codebase with few multi-currency users this is cosmetic.
**Remediation:** rename `userCount` to `rowCount` OR compute
`COUNT(DISTINCT user_id)` and a separate `rowCount`.

### A2-908 — Admin adjustment `reason` is not persisted on the ledger row (Medium)

**File:** `apps/backend/src/credits/adjustments.ts:77-81`.
**Evidence:** `reason` parameter is accepted but only referenced
inside the HTTP handler's `admin_idempotency_keys.response_body` +
Discord audit envelope (per comment). After the idempotency-key 24h
TTL sweep (phase 6 A2-721 flagged the sweep itself as unverified),
the `reason` is unrecoverable.
**Impact:** ADR 017 #4 claims "the full story — who did it, why,
what was the prior and new balance — is reconstructable from the
append-only ledger without an edit log." After 24h this claim is
false for the "why." An audit 3 months later will find the who
(referenceId) and what (amountMinor, priorBalance on the admin
handler's log) but not the why.
**Remediation:** add a `reason text` column to `credit_transactions`
(nullable; populated by admin writers) OR a sibling
`credit_transaction_meta` table keyed on the credit_transaction id.

---

## 11. Severity summary

- **Critical:** A2-610 (re-confirmed), A2-611 (empirically replayed),
  A2-619 (re-confirmed) — all from prior phases, amplified with
  runtime evidence.
- **High (new, this phase):** A2-900, A2-901, A2-902, A2-903, A2-906
- **Medium (new):** A2-904, A2-908
- **Low (new):** A2-907

Total new findings in A2-900..A2-908: **9**. All prior A2-6xx / A2-7xx
financial findings re-confirmed or re-prioritised as noted.

### Invariants I could NOT verify

1. **Real-world CTX → supplier-spend cross-reconciliation.** Plan §6.5
   step 6 asks for a 1000-row window where `supplier-spend` output is
   reproduced from raw orders in a notebook. No orders exist; no CTX
   invoice data is in scope. Deferred to a post-seed phase.
2. **Ledger → on-chain consistency.** Plan §6.5: "every
   `payouts_submitted` row has a matching Stellar transaction." No
   Stellar testnet/mainnet contact from this phase; the in-memory
   drift-watcher (asset-drift-watcher.ts) is the production
   detector. Deferred.
3. **Memo uniqueness across real UUID distribution** (G5-36). Empirical
   birthday-collision probe against generated memos skipped — back-of-
   envelope only from phase 5c A2-605.
4. **Interest-accrual idempotency across reruns.** No scheduler to
   actually rerun (A2-905). The property is architecturally absent
   (A2-906) — confirmed by reading, not by runtime rerun.
5. **Fly Postgres connection-limit vs pool size** (phase 6 A2-723).
   No prod access.

### Blockers

None for writing this evidence. Docker was available; migrations
applied; drift injection reproduced. Production remediation:

- **A2-619** must be fixed before cross-currency orders are enabled
  for any real user.
- **A2-610 / A2-611 / A2-906** must be fixed before the interest
  accrual scheduler is wired.
- **A2-900 / A2-902** should be fixed alongside the first
  post-launch reconciliation run.
- **A2-901** blocks support-mediated refunds — required before the
  first customer-support process that could ever need to issue one.
