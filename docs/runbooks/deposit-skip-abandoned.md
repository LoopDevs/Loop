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

| Situation                                                                       | Action                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order expired before the deposit validated (late payment, oracle outage window) | Refund the deposit to the sender address via the admin emission writer (ADR 024 / ADR 036 — note an emission requires matching mirror balance), or — with the user's confirmation — re-create the order and apply the deposit manually.                                                                                                                                   |
| `reason = missing_credit_row` (A4-110 state corruption)                         | Follow the credit-row recovery in `ledger-drift.md` first; once the `user_credits` row exists, re-open the skip row — `POST /api/admin/watcher-skips/:paymentId/reopen` from the admin UI (ADR 037; audited, resets the attempt budget), or via SQL (`UPDATE payment_watcher_skips SET status='pending', attempts=0 WHERE payment_id='…'`) — and let the next tick retry. |
| `reason = asset_mismatch` (user sent the wrong asset)                           | Contact the user; refund to sender per the support policy.                                                                                                                                                                                                                                                                                                                |
| `reason = processing_error` with a persistent `last_error`                      | This is a code defect — file it, fix it, then re-open the skip row as above (admin UI reopen or SQL) so the sweep replays the deposit.                                                                                                                                                                                                                                    |

## Afterwards

- Record the outcome in the monthly reconciliation sheet (`monthly-reconciliation.md`) — abandoned
  deposits are a reconciliation line item until refunded or credited.
- If two or more abandonments share a `reason`, treat it as systemic and open an issue rather than
  resolving rows one by one.
