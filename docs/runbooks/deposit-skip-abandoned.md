# Runbook — 🔴 Skipped Deposit Abandoned

**Alert source:** `notifyDepositSkipAbandoned` (`apps/backend/src/discord/monitoring.ts`), fired by
the skipped-deposit retry sweep in `apps/backend/src/payments/skipped-payments.ts`.

**What it means:** a real on-chain deposit reached Loop's deposit account, the payment watcher
could not credit it to an order, and the retry path has given up — either the matched order left
`pending_payment` without this deposit (expiry, or another payment won the race) or the row
exhausted its attempt budget (`MAX_SKIP_ATTEMPTS`, ~1 day at the production tick cadence). **The
user's funds are sitting in the deposit account with nothing to show for them.** This is a
customer-impacting state that always needs a human decision.

## Triage (5 minutes)

1. Pull the row:
   ```sql
   SELECT * FROM payment_watcher_skips WHERE payment_id = '<Payment tail-id from the alert>';
   ```
   The `payment` jsonb column holds the full Horizon record (amount, asset, sender, tx hash);
   `reason` + `last_error` say why every retry failed.
2. Find the order and its user (the alert carries the order tail-id):
   ```sql
   SELECT id, user_id, state, payment_method, charge_minor, charge_currency, created_at
   FROM orders WHERE id::text LIKE '%<Order tail-id>';
   ```
3. Confirm the deposit on-chain via the `transaction_hash` in the snapshot (Horizon or any
   explorer) — amount, asset, and sender address.

## Resolution paths

The purpose-built lever for returning a stranded deposit is the **A6 admin
refund** (hardening 2026-07): the deposit account IS the operator account
(CF-18), so this submits an ordinary operator→sender Stellar payment returning
the deposit to its on-chain sender.

> **Refund a deposit → its sender:** `POST /api/admin/deposits/:paymentId/refund`
> from the admin UI (the **Refund** button on the abandoned row in
> `/admin/skips`, admin-tier + step-up) or via curl with a step-up token.
> It reads the sender/amount/asset from the stored Horizon snapshot — you don't
> supply them. **Idempotent + one-time-use**: a re-click / retry never
> double-pays (it pre-checks Horizon for an already-landed refund and converges
> to `already_refunded`). Do NOT use the emission writer for this — that was the
> pre-A6 mechanism and requires a matching mirror balance an unmatched deposit
> never has.

| Situation                                                                       | Action                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order expired before the deposit validated (late payment, oracle outage window) | **Refund to sender** via `POST /api/admin/deposits/:paymentId/refund` (the Refund button on the abandoned row). Or — with the user's confirmation — re-create the order and apply the deposit manually.                                                                                                                                                                   |
| `reason = missing_credit_row` (A4-110 state corruption)                         | Follow the credit-row recovery in `ledger-drift.md` first; once the `user_credits` row exists, re-open the skip row — `POST /api/admin/watcher-skips/:paymentId/reopen` from the admin UI (ADR 037; audited, resets the attempt budget), or via SQL (`UPDATE payment_watcher_skips SET status='pending', attempts=0 WHERE payment_id='…'`) — and let the next tick retry. |
| `reason = asset_mismatch` (user sent the wrong asset)                           | Contact the user; **refund to sender** via the refund endpoint above (it returns exactly what they sent, in the asset they sent).                                                                                                                                                                                                                                         |
| `reason = processing_error` with a persistent `last_error`                      | This is a code defect — file it, fix it, then re-open the skip row as above (admin UI reopen or SQL) so the sweep replays the deposit.                                                                                                                                                                                                                                    |
| Deposit below the dust floor (`DEPOSIT_NOT_REFUNDABLE` on refund)               | Deposits under 10,000 stroops (0.001 unit) are not one-click refundable (the Stellar fee would dwarf the value). Handle out-of-band / write off per the support policy.                                                                                                                                                                                                   |

### Recovering a stuck `refunding` row

A refund whose submit hit an **ambiguous** Horizon error (lost response) is held
in `status='refunding'` **fail-closed** — the system will NOT auto-re-drive it
(deliberate: never risk a double-pay). To recover:

1. Check whether the refund actually landed. The row's `refund_tx_hash` (if set)
   is the last attempted tx — look it up on Horizon:
   `GET https://horizon.stellar.org/transactions/<refund_tx_hash>`. If it
   `successful`, the sender WAS paid — mark it done:
   `UPDATE payment_watcher_skips SET status='refunded' WHERE payment_id='…'`.
2. If it did NOT land (404), just **re-POST the refund endpoint**. It runs the
   Horizon idempotency pre-check first (windowless hash lookup + memo scan), and
   a `refunding` row older than 5 min with no landed refund is safely
   re-claimed and re-submitted — so a second click after the row has sat a few
   minutes converges to a clean refund without any double-pay risk.
3. If it's been <5 min, the endpoint returns `PAYMENT_IN_FLIGHT` (409) — wait
   and retry; the tx may still be settling.

## Afterwards

- Record the outcome in the monthly reconciliation sheet (`monthly-reconciliation.md`) — abandoned
  deposits are a reconciliation line item until refunded or credited.
- If two or more abandonments share a `reason`, treat it as systemic and open an issue rather than
  resolving rows one by one.
