# Runbook · Permanent payout failure (compensation flow)

## Symptom

- `pending_payouts` row in `state='failed'` with `attempts >= max` and
  a `last_error` like `op_no_destination`, `op_no_trust`, or
  `op_line_full`. The submit worker stops retrying and the user's
  off-chain debit is now uncollectible.
- Discord `#ops-alerts` ping from `payout-watchdog` flagging the row
  for finance review.
- For `kind='withdrawal'` rows specifically (ADR-024) — the user's
  cashback balance is **still negative** until compensation lands.

## Severity

- **P1** for a `kind='withdrawal'` permanent failure — user's balance
  is still down; respond same-day.
- **P2** for `kind='order_cashback'` — the user's order was funded, the
  cashback is owed but not paid out; respond next-business-day.

## Diagnosis

1. Read the failed row at `/admin/payouts/<id>`. Confirm:
   - `kind` (drives which flow you use)
   - `lastError` is a non-retryable `op_*` (see Stellar docs for the
     full list — `op_no_destination`, `op_no_trust`, `op_underfunded`
     of the destination, `op_line_full`).
   - `attempts` ≥ the max attempts setting (typically 5).
2. Identify the user (`/admin/users/<userId>`). Note the user's home
   currency and Stellar address.
3. Confirm with the user (via support channel) what they want next:
   - For withdrawal failures: re-issue against a different address?
     Or compensate (refund off-chain) and have the user request a new
     withdrawal once they've added a trustline / fixed their wallet?
   - For order-cashback failures: is the user OK to receive in a
     different LOOP asset? Usually yes once trustline is added.

## Mitigation

### `kind='withdrawal'` → compensate

The admin compensation endpoint (ADR-024 §5) writes a positive
`type='adjustment'` credit-tx referencing the failed payout, restoring
the user's balance.

1. Confirm the row is in `state='failed'` and `kind='withdrawal'`.
2. From the admin panel, hit `/admin/payouts/<id>` (no UI button yet —
   either curl the endpoint directly or use the upcoming admin form).
3. `POST /api/admin/payouts/<id>/compensate` with:
   - Header `Idempotency-Key: <generated-uuid>`
   - Body `{ "reason": "support ticket #N — destination unreachable, refunding off-chain" }`
4. Audit fanout posts to `#admin-audit` automatically.
5. Tell the user (via support) their balance has been restored. They
   can request a new withdrawal once they've fixed their wallet
   (added trustline, recreated account, etc.).

### `kind='order_cashback'` → fix root cause

For order-cashback payout failures, the user's order is fulfilled but
the on-chain cashback never landed.

- **Trustline missing**: tell the user via support to add the LOOP
  asset trustline. The submit-worker watcher will pick the row back up
  once trustline appears. No admin action.
- **Permanent destination issue**: open the existing refund flow
  (`POST /api/admin/users/:userId/refunds` against the order id) to
  credit the user off-chain. The compensation flow is for withdrawal
  payouts only — refund is for order-funded ones (ADR-024 §5 rationale).

## Resolution

For withdrawal failures the compensation row closes the loop — the
user is whole. For order-cashback failures the admin refund closes the
ledger; the user can re-trigger payout via the resync flow once their
wallet is set up.

## Post-mortem

- Always for `kind='withdrawal'` permanent failure — write up the
  cause + the time-to-compensate. Track patterns: if `op_no_destination`
  shows up >3 times in a month, the wallet-funding flow has a UX gap
  worth a separate ticket.
- Document the compensation in the user's support ticket so future
  reviewers see the closed loop.
