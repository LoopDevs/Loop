# Runbook · `notifyPegBreakOnFulfillment` alert (Discord `#ops-alerts`)

## Symptom

`#ops-alerts` Discord embed titled **"🚨 LOOP-asset peg break on
fulfillment"** with fields:

- `Order` — the fulfilled order id
- `User` — the user the cashback was credited to
- `Charge ccy` — the currency the order was pinned to (`chargeCurrency`)
- `Home ccy` — the user's `homeCurrency` at fulfillment time
- `Cashback (minor)` — the cashback amount written off-chain

Source: `apps/backend/src/discord/monitoring.ts::notifyPegBreakOnFulfillment`,
fired from `apps/backend/src/orders/fulfillment.ts` (A4-023). It fires
**once per affected order** — there is no paired recovery notifier, so the
operator closes it manually after compensating.

## What "peg break" means

At fulfillment the order's pinned `chargeCurrency` diverged from the user's
`homeCurrency`. The off-chain cashback row **still writes** (off-chain
liability is the source of truth, ADR-009), but the on-chain LOOP-asset
payout is **skipped** because the watcher/payout path can't pick a single
LOOP asset to mint. The result: Loop owes the user cashback off-chain with
no matching on-chain LOOP-asset payout, so the 1:1 backing peg is broken
for that amount until an operator manually issues the on-chain payout in the
correct currency.

## Severity

**P1** — a ledger/peg-correctness divergence on real money. The loss is
bounded by the single order's `Cashback (minor)`, and the user's off-chain
balance is intact, so it is not P0. ACK in 30 min; resolve same-day.

## Diagnosis (first 10 minutes)

1. **Read the embed.** Note the order id, user id, `chargeCurrency`,
   `homeCurrency`, and `cashbackMinor`.
2. **Confirm the off-chain credit landed** (it should have):
   ```sql
   SELECT id, user_id, currency, balance_minor
   FROM user_credits WHERE user_id = '<user id>';
   ```
   The credited currency is the user's `homeCurrency` per ADR-009.
3. **Confirm no on-chain payout was issued for this order's cashback:**
   ```sql
   SELECT id, kind, state, asset_issuer, amount_stroops, tx_hash
   FROM pending_payouts WHERE order_id = '<order id>';
   ```
   Expect **no `order_cashback` row** (the payout was skipped). If a row
   exists and confirmed, the peg is already intact — close the alert.
4. **Check why the currencies diverged.** Inspect the order and the user:
   ```sql
   SELECT id, charge_currency, charge_minor, state FROM orders WHERE id = '<order id>';
   SELECT id, home_currency FROM users WHERE id = '<user id>';
   ```
   The usual cause is a home-currency change between order creation and
   fulfillment (admin home-currency change is gated against live balances
   and in-flight payouts, but an in-flight _order_ can still straddle it).

## Mitigation

1. **Decide the target currency.** The off-chain credit was written in the
   user's `homeCurrency` (step 2). The on-chain payout must be minted in the
   LOOP asset matching **that same currency** so on-chain == off-chain.
2. **Confirm the matching LOOP-asset issuer is configured** for that
   currency (`LOOP_STELLAR_USDLOOP_ISSUER` / `_GBPLOOP_ISSUER` /
   `_EURLOOP_ISSUER`). If unset, the deployment can't pay that currency
   on-chain — escalate to ops to wire the issuer before compensating.
3. **Issue the manual on-chain payout** in the correct currency for
   `cashbackMinor`, signed from the operator account. Use the same
   submit/idempotency path as a normal payout (ADR-016) so a retry can't
   double-pay — re-using the order's payout memo keeps it idempotent.
4. **Alternatively, reset the user's home currency** (admin home-currency
   change, `PUT /api/admin/users/:userId/home-currency`) so future
   fulfillments don't recur — but this does **not** retroactively fix the
   already-credited cashback; you still owe the on-chain payout from step 3.

## Resolution

There is no automatic recovery notifier. Once the on-chain payout confirms
(or you have deliberately accepted the divergence), post a manual `✅`
message in `#ops-alerts` tagging the order id and the compensating Stellar
`tx_hash`. Cross-check with the asset-drift watcher — the settlement-backlog
side of `notifyAssetDrift` should not show this amount once the payout lands.

## Post-mortem

- Always write one (P1 money-correctness divergence). The root cause is
  almost always a home-currency change straddling an in-flight order; the
  fix is product/policy (when a home-currency change is allowed relative to
  open orders) rather than a one-off operator action.
- If two or more peg breaks share a cause, treat it as systemic and file an
  engineering ticket to close the order ↔ home-currency race at the source.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md) — the aggregate
  drift watcher; a peg break contributes to the settlement-backlog (`−`)
  side until the manual payout lands.
- [`ledger-drift.md`](./ledger-drift.md) — broader off-chain vs on-chain
  reconciliation.
- ADR 009 §cashback flow — why the off-chain ledger is the source of truth.
- ADR 015 / 016 — the on-chain LOOP-asset payout + idempotency the manual
  compensation reuses.
