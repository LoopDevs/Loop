# Runbook · Operator XLM/USDC float reconciliation (R3-1)

**Alert source:** `notifyOperatorFloatDrift` (`apps/backend/src/discord/monitoring.ts`),
fired by `apps/backend/src/payments/operator-float-reconciliation.ts` — the
scheduled reconciler that watches the real Stellar operator/deposit wallet
(`LOOP_STELLAR_DEPOSIT_ADDRESS`), the account every user deposit, CTX
settlement payment, and on-chain refund actually flows through.

**Why this exists (and how it differs from the other drift watchers):**
Loop already has two automated reconciliations — `ledger-invariant-watcher`
(mirror = ledger, INV-1) and `asset-drift-watcher` (on-chain LOOP vs. mirror,
INV-4). **Neither watches the operator wallet itself.** This watcher is the
one that would catch a leak, a mis-swept top-up, or a mis-recorded CTX
settlement in the actual XLM/USDC that moves in and out of Loop's custody.
It is **detection + audit-trail only — it makes no balance-adjusting writes**
to `user_credits` or any ledger table; it only classifies Horizon movements
and pages when something doesn't add up.

## What "reconciles" means here

This is a **historical conservation check**, not a point-in-time balance
card. Per asset (`xlm`, `usdc`):

```
actual operator balance ≈ baseline opening balance
                         + classified inbound movements
                         − classified outbound movements
                         ± approved manual movements
```

- **Baseline** — an operator-chosen balance + Horizon cursor snapshot,
  taken at the same moment (`operator_wallet_baselines`). There is no
  reconciliation without one: absence of an active baseline is the
  fail-closed `needs_baseline` state, not "healthy". `needs_baseline` pages
  Discord too (2026-07-10 production-readiness pass) — a deployed watcher
  sitting on `needs_baseline` forever means nobody has configured R3-1 yet,
  and silence must not be mistaken for a passing check.
- **Movements** — every Horizon `payment` operation touching the account
  since the baseline, indexed and classified (`operator_wallet_movements`).
- **Classification** is keyed off Loop's own DB records, **never off memo
  text** (see §Memo policy below): `user_deposit` (an inbound payment
  Loop's payment watcher already linked to a paid order, or a recorded
  watcher-skip), `ctx_settlement` (an outbound payment matching a
  `ctx_settlements` row by tx hash), `deposit_refund` (an outbound A6/R3-2
  refund matching a skip row), `manual` (an operator-approved explanation,
  see below), or `unclassified` — anything else.
- **Runs** persist to `operator_float_reconciliation_runs` every tick and
  surface on `GET /api/admin/treasury` (`operatorFloat.xlm` /
  `operatorFloat.usdc`) and `GET /api/admin/operator-float/movements`.

## Symptom

`#ops-alerts` (the monitoring webhook) Discord embed titled **"🔴 Operator
Float Reconciliation — `<state>`"** where `<state>` is one of:

| State            | Meaning                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs_baseline` | No active baseline for this (account, asset). The watcher has not checked anything.                                                                                           |
| `unclassified`   | At least one movement since the baseline could not be classified. Balance may still be `ok`.                                                                                  |
| `drift`          | `                                                                                            actual − expected` exceeds the per-asset threshold, with zero unclassified rows. |
| `error`          | The run itself failed (Horizon read error, DB error, etc.) — see the `error` field.                                                                                           |

Fields: `Asset`, `State`, `Account` (truncated), `Expected`, `Actual`,
`Delta`, `Threshold`, `Unclassified` (all in stroops).

## Severity

| State            | Severity                                                                                   | SLA                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `needs_baseline` | **P2** until go-live, **P1** after (means R3-1 has silently stopped protecting the wallet) | Configure the baseline (§Setting the baseline) same-day.                                        |
| `unclassified`   | **P1**                                                                                     | Triage within a few hours — an unexplained movement could be a leak, or just a lagging linkage. |
| `drift`          | **P0**                                                                                     | Real balance disagrees with the conserved expectation. ACK 30 min, triage same-day.             |
| `error`          | **P2**                                                                                     | Usually a transient Horizon/DB issue; escalate if it repeats across ticks.                      |

## Triage

### `needs_baseline`

This is expected on a fresh deploy or right after a re-baseline is
deliberately retired. Confirm which:

1. `SELECT * FROM operator_wallet_baselines WHERE account = '<account>' AND asset = '<asset>' ORDER BY created_at DESC LIMIT 3;`
2. If there is truly no row, or the newest row has `active = 0` and nobody
   meant to deactivate it — go to §Setting the baseline.
3. If a baseline was JUST created and you're still seeing `needs_baseline`,
   wait for the next tick (`LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS`,
   default 24h) or trigger one manually (see §Forcing a tick).

### `unclassified`

1. Pull the unclassified rows: `GET /api/admin/operator-float/movements?classification=unclassified`
   (admin-tier; from the admin UI's Treasury drill or via curl with a bearer
   token).
2. For each row, check `fromAddress` / `toAddress` / `memoText` /
   `amountStroops` against what ops knows about recent activity — a manual
   top-up, a sweep to cold storage, a fee payment, a one-off correction.
3. **Every tick re-runs classification over stuck `unclassified` rows**
   (`reclassifyUnclassifiedMovements`), so a row that's actually a user
   deposit or CTX settlement usually self-heals once the payment watcher /
   settlement writer catches up — don't rush to hand-classify something
   that might resolve on its own within a tick or two.
4. If it's still unclassified after that and it's a real operator action,
   explain it (§Explaining a manual movement). If it's NOT something ops
   recognizes, treat it as a potential leak — escalate to `drift`'s P0
   triage.

### `drift`

1. **Cross-check on Horizon directly** — don't trust just the embed. Fetch
   the account: `GET https://horizon.stellar.org/accounts/<account>` and
   compare its native/USDC balance against the `Actual` field.
2. **Read `Expected` vs `Actual`.** The reconciler already recomputes once
   before paging (a deposit landing in the index/balance-read window does
   not false-page), so a page here means the drift survived a re-check.
3. **Check for the known unmodeled terms first** (see the module docstring
   in `payments/operator-float-reconciliation.ts`): transaction fees on
   every operator-submitted tx (~100-200 stroops each — this is exactly
   why XLM's default threshold is 1 XLM wide) are NOT counted by the
   model. If the drift is small, negative, and XLM-only, it is very
   likely just accumulated fee drift — re-baseline (§Setting the
   baseline) rather than doing anything else. **Do not raise the
   threshold to make the page go away** — threshold inflation is exactly
   how a real leak would hide; re-baselining instead keeps the check
   honest because it re-zeros against a freshly observed truth.
4. If the drift is large, USDC, or doesn't shrink after ruling out fees —
   treat as a real incident: this is real money either missing from or
   unaccounted-for in the operator wallet. Escalate per `docs/oncall.md`.
   Cross-check `unclassified` count too — a drift with nonzero
   `unclassified` should be triaged as an unclassified-movement
   investigation first (the drift number is unreliable while movements are
   still unexplained).

## Setting the baseline (👤 operator step)

**Production baseline/cursor values do not exist in the repo — this is
inherently operator data**, not something to be invented, guessed, or
hardcoded. Setting the first production baseline is a required go-live step
for R3-1; do it once the real `LOOP_STELLAR_DEPOSIT_ADDRESS` operator
account exists and before relying on this watcher.

1. Pick a snapshot moment. Read the account's CURRENT state from Horizon in
   one call:
   ```
   GET https://horizon.stellar.org/accounts/<LOOP_STELLAR_DEPOSIT_ADDRESS>
   ```
   Note the XLM balance (`balances[] where asset_type=native`) and the
   USDC balance (`balances[]` matching `LOOP_STELLAR_USDC_ISSUER`), in
   stroops (7 decimals — multiply the decimal balance by `10^7`).
2. Get the cursor anchored to that exact moment — the LAST payment the
   account has seen as of the snapshot:
   ```
   GET https://horizon.stellar.org/accounts/<account>/payments?order=desc&limit=1
   ```
   Take the `paging_token` of that record (or, on a genuinely brand-new
   account with zero payment history, use `"0"`). **This is the single
   most important value** — an anchor taken from any moment OTHER than
   the balance read will double-count or miss movements between the two
   reads.
3. Mint a step-up token (5-minute TTL, ADR 028) — you need to already be
   signed in as an admin:
   ```bash
   curl -sX POST https://api.loopfinance.io/api/admin/step-up \
     -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"kind":"otp","otp":"<the OTP you just requested>"}'
   ```
4. Create the baseline (repeat once per asset — `xlm` and `usdc` are
   independent baselines):
   ```bash
   curl -sX POST https://api.loopfinance.io/api/admin/operator-float/baselines \
     -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
     -H "X-Admin-Step-Up: $STEP_UP_TOKEN" \
     -H "Idempotency-Key: r3-1-baseline-xlm-$(date +%s)" \
     -H "Content-Type: application/json" \
     -d '{
       "asset": "xlm",
       "account": "<LOOP_STELLAR_DEPOSIT_ADDRESS>",
       "openingBalanceStroops": "<balance from step 1, in stroops>",
       "startingHorizonCursor": "<paging_token from step 2>",
       "reason": "R3-1 go-live: initial production baseline"
     }'
   ```
   `startingHorizonCursor` is **required and non-empty** — both at the API
   layer (Zod) and, as of the 2026-07-10 production-readiness pass, at the
   DB layer (migration 0057, `NOT NULL` + length CHECK). An omitted or
   empty cursor is rejected outright rather than silently causing the
   indexer to walk the account's entire payment history from genesis.
5. Creating a new baseline for an (account, asset) that already has an
   active one **automatically deactivates the prior one** in the same
   transaction (`operator_wallet_baselines_one_active`, migration 0054
   enforces exactly one active row per account+asset at the DB layer) —
   the reconciler always reconciles against the newest.
6. Confirm: `GET /api/admin/treasury` should show `operatorFloat.<asset>.state`
   move from `needs_baseline` to `ok` (or `drift`/`unclassified` if
   something's already off) after the next tick, or force one
   (§Forcing a tick).

### Re-baselining (routine maintenance, not just incident recovery)

Do this periodically as fee drift accumulates (see the `drift` triage
above), or any time ops needs to draw a fresh line under a known-good
state (post-investigation, post-manual-correction). Same steps as initial
setup — read a fresh balance + cursor pair from Horizon and POST a new
baseline. The old baseline's history stays in `operator_wallet_movements`
for audit purposes; only the ACTIVE baseline matters for the live
reconciliation.

## Memo policy

The reconciler's classifier **never trusts memo text for classification** —
by design. Memo text is Stellar-visible and attacker-controllable (anyone
can send a payment to the operator account with any memo they like), so
auto-classifying a movement as "explained" based on its memo alone would let
an attacker (or a typo) suppress a real drift page. Every automatic
classification instead keys off Loop's own authenticated DB records:

- **User deposits** already carry a per-order memo generated by
  `orders/cashback-split.ts` and matched by the payment watcher
  (`payments/watcher.ts`) — this is entirely automatic; operators don't
  generate or manage these memos.
- **CTX settlements** carry a per-order memo from CTX's own SEP-7 URI,
  matched by tx hash against `ctx_settlements` — also fully automatic.
- **Deposit refunds** are matched by tx hash against `payment_watcher_skips`
  — also fully automatic.

**Operator-initiated movements — manual top-ups, sweeps to cold storage,
fee payments, one-off corrections — have NO automatic classification
path**, regardless of what memo they carry. Every such movement lands
`unclassified` and pages until an admin explains it:

1. Still tag the on-chain transaction with a human-readable memo (e.g.
   `"loop-ops:topup"`) for your own audit trail — the reconciler stores it
   (`memoText` on `operator_wallet_movements`) for triage even though it
   never acts on it.
2. Once the movement is indexed (next tick after it lands on-chain — check
   `GET /api/admin/operator-float/movements?classification=unclassified`),
   explain it via the audited, step-up-gated write:
   ```bash
   curl -sX POST https://api.loopfinance.io/api/admin/operator-float/manual-movements \
     -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
     -H "X-Admin-Step-Up: $STEP_UP_TOKEN" \
     -H "Idempotency-Key: r3-1-manual-$(date +%s)" \
     -H "Content-Type: application/json" \
     -d '{
       "asset": "xlm",
       "account": "<account>",
       "direction": "in",
       "amountStroops": "<exact amount>",
       "movementPaymentId": "<Horizon payment id from the movements list>",
       "reason": "Quarterly float top-up from treasury, approved by <who>"
     }'
   ```
   The endpoint validates the link before accepting it (2026-07-08 money
   review): `movementPaymentId` must reference a movement that (a) exists,
   (b) is still `unclassified`, and (c) structurally matches the declared
   `asset`/`account`/`direction`/`amountStroops` — it cannot be used to
   bless an unrelated or mismatched movement, overwrite an already-attributed
   row, or silently no-op on a typo'd id.
3. **Do the explanation promptly** (same or next reconciliation window). A
   manual movement that sits unexplained pages `unclassified` every tick
   until someone links it — that's the deliberate "detection, not silent
   pass" design, not a bug to route around.

If you're tempted to add memo-based auto-classification instead of doing
step 2 every time: don't. That would demote the classification guarantee
from "authenticated admin write" to "whatever memo the sender chose",
which is exactly the kind of DB/runtime-tier-to-convention regression
`docs/invariants.md` warns about.

## Forcing a tick

There's no manual-trigger endpoint. To force a fresh read outside the
scheduled cadence, either wait for the next tick
(`LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS`) or restart the
backend process (the watcher runs once immediately on start, in addition
to the interval timer) — restarting is a blunt instrument, prefer just
waiting unless you're actively validating a fix.

## Resolution

There is no automatic recovery signal for this alert (unlike
`asset-drift-alert.md`'s `notifyAssetDriftRecovered`) — it pages on every
bad-state tick until the state returns to `ok`. Once resolved, the next
healthy tick simply stops paging; post a manual `✅` in `#ops-alerts`
summarizing the cause for anything that reached P0/P1.

## Post-mortem

- **Always** for `drift` incidents that were NOT explained by known fee
  drift.
- **For `needs_baseline` reaching P1** (post-launch, alive for more than a
  day): means the go-live checklist missed wiring up R3-1's baseline —
  file it so the deploy runbook gets a gate for this.

## Related

- `docs/adr/038-money-path-hardening.md` — the 2026-07 hardening pass this
  reconciler's design decisions build on (D2's persisted/at-least-once
  paging pattern).
- `docs/invariants.md` — the money-invariant catalog; this watcher is a
  detection layer alongside (not a replacement for) INV-1/INV-4.
- [`ledger-drift.md`](./ledger-drift.md) — the sibling mirror=ledger check.
- [`asset-drift-alert.md`](./asset-drift-alert.md) — the sibling
  on-chain-LOOP-vs-mirror check.
- [`monthly-reconciliation.md`](./monthly-reconciliation.md) — the
  CTX-invoice-level reconciliation this watcher complements at the
  wallet level.
