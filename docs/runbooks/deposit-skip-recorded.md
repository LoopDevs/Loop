# Runbook — 🟠 Deposit Skipped — needs investigation

**Alert source:** `notifyDepositSkipRecorded`
(`apps/backend/src/discord/monitoring.ts`), fired by the payment watcher's
skip path in `apps/backend/src/payments/skipped-payments.ts`.

**What it means:** a real on-chain deposit reached Loop's deposit account but
the payment watcher could **not** credit it to its order on this tick, so it
recorded a `payment_watcher_skips` row and will retry. This is the
**first-touch** alert; it pages only for the reasons that are not expected to
self-heal — `missing_credit_row` and `processing_error` (see
`ALERT_ON_FIRST_RECORD` in `skipped-payments.ts`). The transient reasons
(`asset_mismatch`, `amount_insufficient`) record silently and only page if
they later **abandon** (see `deposit-skip-abandoned.md`).

The embed carries `Reason`, `Payment` (last 8 of the payment id), `Order`
(last 8, or `none`), and an optional `Detail`.

## Severity

**P2** — the deposit is safe in Loop's deposit account and the sweep will
retry (up to `MAX_SKIP_ATTEMPTS`, ~1 day at the production tick cadence).
It pages on first record because the alerting reasons usually need an
operator/code fix to clear before the budget runs out. Resolve before the
row abandons; treat as **P1** if several deposits skip with the same reason
(systemic).

## Triage (5 minutes)

1. Pull the row:
   ```sql
   SELECT * FROM payment_watcher_skips WHERE payment_id LIKE '%<Payment tail-id>';
   ```
   The `payment` jsonb column holds the full Horizon record (amount, asset,
   sender, tx hash); `reason`, `attempts`, and `last_error` say why the
   credit failed.
2. Find the order + user (the alert carries the order tail-id, if any):
   ```sql
   SELECT id, user_id, state, payment_method, charge_minor, charge_currency, created_at
   FROM orders WHERE id::text LIKE '%<Order tail-id>';
   ```
3. Confirm the deposit on-chain via the `transaction_hash` in the snapshot
   (Horizon or any explorer) — amount, asset, sender.

## Resolution paths

| Reason                | Meaning                                                                         | Action                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_credit_row`  | The `user_credits` row the watcher expected is absent (A4-110 state corruption) | Recover the credit row first via `ledger-drift.md`; once it exists, re-open the skip so the next tick retries: `UPDATE payment_watcher_skips SET status='pending', attempts=0 WHERE payment_id='…'`. |
| `processing_error`    | An exception was thrown while crediting (code defect)                           | Read `last_error`; file + fix the defect, then re-open the skip row as above so the sweep replays the deposit.                                                                                       |
| `asset_mismatch`      | User sent the wrong asset (only pages if it later abandons)                     | Contact the user; refund to the sender address per support policy (admin withdrawal writer, ADR 024).                                                                                                |
| `amount_insufficient` | Deposit was below the order amount (only pages if it later abandons)            | Wait for a top-up deposit, or refund + cancel per support policy.                                                                                                                                    |

## Afterwards

- If the row clears on its own (the retry succeeds), the `status` flips to
  `resolved` — no further action; the page was a heads-up.
- If it does **not** clear before the attempt budget runs out, it escalates
  to `notifyDepositSkipAbandoned` — follow `deposit-skip-abandoned.md`.
- If two or more skips share a `reason`, treat it as systemic and open an
  issue rather than re-opening rows one by one.

## Related

- [`deposit-skip-abandoned.md`](./deposit-skip-abandoned.md) — the terminal
  sibling alert when the retry budget is exhausted (funds need manual
  reconciliation).
- [`ledger-drift.md`](./ledger-drift.md) — credit-row recovery for the
  `missing_credit_row` reason.
- [`payment-watcher-stuck.md`](./payment-watcher-stuck.md) — if deposits are
  not being processed at all (cursor stall) rather than skipped per-row.
