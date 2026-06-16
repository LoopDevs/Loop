# Runbook — 🟠 Deposit Skipped — needs investigation

**Alert source:** `notifyDepositSkipRecorded`
(`apps/backend/src/discord/monitoring.ts`), fired on the **first**
skip of a deposit by the payment watcher in
`apps/backend/src/payments/skipped-payments.ts` on the monitoring
channel (`DISCORD_WEBHOOK_MONITORING`).

**What it means:** the payment watcher saw an incoming deposit it could
not credit to an order and recorded a skip row. This first-touch alert
fires only for the reasons ops should look at immediately —
`missing_credit_row` (A4-110 state corruption: the matched order has no
`user_credits` row) and `processing_error` (an unexpected exception).
Transient reasons (`amount_insufficient` during an oracle blip,
`asset_mismatch` from user error) retry quietly under the skip-attempt
budget and only page on **abandonment** — see
[`deposit-skip-abandoned.md`](./deposit-skip-abandoned.md).

This is the early-warning sibling of the abandonment page: catching the
deposit on the first skip means you can fix the cause before the row
burns through its retry budget (`MAX_SKIP_ATTEMPTS` = 2880, ≈ 1 day at
the 30s production tick).

## Severity

**P2.** The deposit is still being retried, so funds are not yet stuck —
but `missing_credit_row` / `processing_error` indicate a defect or
state corruption that won't self-heal. ACK same-day; fix before the row
abandons.

## Triage (5 minutes)

1. Pull the skip row (the alert carries the Payment tail-id):
   ```sql
   SELECT * FROM payment_watcher_skips WHERE payment_id LIKE '%<Payment tail-id>';
   ```
   The `payment` jsonb column holds the full Horizon record (amount,
   asset, sender, tx hash); `reason` + `last_error` say why it skipped.
2. If the alert carries an order tail-id, pull the order + user:
   ```sql
   SELECT id, user_id, state, payment_method, charge_minor, charge_currency, created_at
   FROM orders WHERE id::text LIKE '%<Order tail-id>';
   ```
3. Confirm the deposit on-chain via the snapshot's `transaction_hash`.

## Resolution

| Reason               | Action                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_credit_row` | State corruption (A4-110). Follow the credit-row recovery in [`ledger-drift.md`](./ledger-drift.md) to create the `user_credits` row, then let the next sweep tick retry the deposit. Do **not** wait for abandonment — fix it now. |
| `processing_error`   | A persistent `last_error` is a code defect. File it, fix it, then re-open the row (`UPDATE payment_watcher_skips SET status='pending', attempts=0 WHERE payment_id='…'`) so the sweep replays the deposit.                          |

After any state-mutating step, post in `#ops-alerts` with the payment
id (last-8) and the action taken (no silent fixes).

## Afterwards

- If the row still cannot be credited and exhausts its budget, it will
  re-page as `notifyDepositSkipAbandoned` — handle it per
  [`deposit-skip-abandoned.md`](./deposit-skip-abandoned.md).
- Two or more first-touch skips sharing a `reason` is systemic — open an
  issue rather than resolving rows one by one.

## Related

- [`deposit-skip-abandoned.md`](./deposit-skip-abandoned.md) — the
  terminal "funds need manual reconciliation" page.
- [`ledger-drift.md`](./ledger-drift.md) — credit-row recovery.
- [`payment-watcher-stuck.md`](./payment-watcher-stuck.md)
