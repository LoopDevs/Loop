# Runbook — 🚨 LOOP-asset peg break on fulfillment

**Alert source:** `notifyPegBreakOnFulfillment`
(`apps/backend/src/discord/monitoring.ts`), fired from the fulfillment
path (`apps/backend/src/orders/fulfillment.ts`, A4-023) on the
monitoring channel (`DISCORD_WEBHOOK_MONITORING`).

**What it means:** an order fulfilled with a pinned `chargeCurrency`
that no longer matches the user's `homeCurrency`. The off-chain cashback
ledger row **was written** (off-chain liability is the source of truth,
ADR 009), but the matching **on-chain LOOP-asset payout was SKIPPED** —
so on-chain circulation is now short of the ledger liability for that
asset. The 1:1 peg is broken for that user until an operator manually
issues the on-chain payout (or reconciles the divergence). This pages
because it is a ledger/peg-correctness divergence, not a transient.

## Severity

**P1.** Bounded loss (one order's cashback), but it is a real
off-chain ⇄ on-chain divergence that the asset-drift watcher will count
as settlement backlog (negative drift) until resolved. ACK in 30 min,
resolve same-day.

> **Phase-1 note:** with cashback off (`LOOP_PHASE_1_ONLY=true`,
> `LOOP_WORKERS_ENABLED=false`, no `LOOP_STELLAR_*LOOP_ISSUER` set) no
> on-chain payout happens at all, so this alert is **gated** — it only
> fires once cashback mode is live. If you see it in Phase 1, something
> is misconfigured; check the gates first.

## Triage (first 10 minutes)

1. Read the embed: `Order`, `User`, `Charge ccy`, `Home ccy`,
   `Cashback (minor)`. The mismatch (`Charge ccy` ≠ `Home ccy`) is the
   root cause.
2. Pull the order + the user's current home currency:
   ```sql
   SELECT o.id, o.user_id, o.state, o.charge_currency, o.charge_minor,
          o.fulfilled_at, u.home_currency
   FROM orders o JOIN users u ON u.id = o.user_id
   WHERE o.id = '<Order id from the alert>';
   ```
3. Confirm the cashback row was written off-chain and no payout exists:
   ```sql
   SELECT id, currency, amount_minor, kind, created_at
   FROM credit_transactions WHERE order_id = '<Order id>';
   SELECT id, state, asset_code, amount, kind
   FROM pending_payouts WHERE order_id = '<Order id>';
   ```
   Expect a `credit_transactions` cashback row and **no** matching
   `pending_payouts` row — that gap is the peg break.

## Resolution

Decide between the two outcomes — confirm with the on-call lead before
moving money:

| Situation                                                                            | Action                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User's home currency is correct now; the order was just charged in an older currency | Issue the on-chain payout manually in the **order's `chargeCurrency`** so on-chain matches the off-chain cashback row, restoring the 1:1 peg. Use the operator account's issuer for that asset. Record the tx hash.                         |
| The user's home currency was changed in error and should be reverted                 | Revert it via `POST /api/admin/users/:userId/home-currency` (ADR 015 support-mediated change; requires actor + idempotency key + reason; step-up gated). Then re-evaluate whether the cashback should be re-paid in the corrected currency. |
| Divergence is acceptable (one-off, tiny amount) and you choose to absorb it          | Record the decision; the off-chain credit stays, the on-chain mint is intentionally skipped. Note it on the monthly reconciliation sheet so the asset-drift backlog is explainable.                                                         |

After any state-mutating step, post in `#ops-alerts` with the order id
(last-8), the action taken, and the tx hash if a payout was issued (no
silent fixes).

## Afterwards

- Add the order to the monthly reconciliation sheet
  (`monthly-reconciliation.md`) as a peg-break line item until the
  on-chain payout lands or the divergence is formally written off.
- Repeated peg breaks point at a home-currency-change flow that doesn't
  block while orders are in flight — file it as a code defect, not a
  per-row operations task.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md) — the watcher that
  will report this as negative (settlement-backlog) drift.
- [`ledger-drift.md`](./ledger-drift.md) — broader off-chain ⇄ on-chain
  reconciliation.
- [`monthly-reconciliation.md`](./monthly-reconciliation.md)
