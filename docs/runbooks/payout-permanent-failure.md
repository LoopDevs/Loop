# Runbook · Permanent payout failure (compensation flow)

## Symptom

- `pending_payouts` row in `state='failed'` with `attempts >= max` and
  a `last_error` like `op_no_destination`, `op_no_trust`, or
  `op_line_full`. The submit worker stops retrying and the user's
  off-chain debit is now uncollectible.
- Discord `#ops-alerts` ping from `payout-watchdog` flagging the row
  for finance review.
- For LEGACY pre-ADR-036 `kind='emission'` rows specifically (the
  ones carrying an at-send `type='withdrawal'` debit — ADR-024) —
  the user's cashback balance is **still down** until compensation
  lands. Post-ADR-036 emissions never debit, so there is no balance
  hole — only an owed on-chain backfill.

## Severity

- **P1** for a legacy `kind='emission'` permanent failure — user's
  balance is still down; respond same-day. Also **P1** for
  `kind='burn'` (ADR 036 issuer-return) — the mirror is debited and
  the redeemed LOOP is stranded at the deposit account; operator-side
  config is almost always the cause.
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
   - For legacy emission failures: re-issue against a different
     address? Or compensate (refund off-chain) and have the user
     re-request once they've added a trustline / fixed their wallet?
   - For order-cashback failures: is the user OK to receive in a
     different LOOP asset? Usually yes once trustline is added.

## Mitigation

### `kind='emission'` (legacy) → compensate

The admin compensation endpoint (ADR-024 §5, narrowed by ADR 036)
writes a positive `type='adjustment'` credit-tx referencing the
failed payout, restoring the user's balance. It only applies to
LEGACY pre-ADR-036 rows — the primitive checks for the at-send
`type='withdrawal'` debit row and refuses post-ADR-036 emissions
with `PAYOUT_NOT_COMPENSABLE` (compensating a debit-less emission
would mint unbacked mirror balance).

1. Confirm the row is in `state='failed'`, `kind='emission'`, and a
   `credit_transactions` row with `type='withdrawal'` references the
   payout id (legacy marker).
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
  credit the user off-chain. The compensation flow is for legacy
  debited emissions only — refund is for order-funded ones (ADR-024
  §5 rationale).

### `kind='burn'` (ADR 036 issuer-return) → fix config + retry

The destination is our own issuer account, which always accepts its
asset back. A failed burn means the pinned `asset_issuer` is wrong
(env var typo, issuer rotation without re-pinning) or Horizon was
down through the retry window. Verify `LOOP_STELLAR_<CODE>_ISSUER`
matches the row's `asset_issuer`, then re-queue with
`POST /api/admin/payouts/<id>/retry`. **Never compensate a burn** —
the redemption debit it pairs with is correct; until the burn lands
the drift watcher counts the row in its in-flight-burn term, so the
books stay honest while you fix it.

## Resolution

For legacy emission failures the compensation row closes the loop —
the user is whole. For order-cashback failures the admin refund
closes the ledger; the user can re-trigger payout via the resync flow
once their wallet is set up. For burns, the retried row confirming
(LOOP returned to the issuer) is the closure.

## Post-mortem

- Always for `kind='emission'` or `kind='burn'` permanent failure —
  write up the cause + the time-to-compensate (or time-to-burn). Track patterns: if `op_no_destination`
  shows up >3 times in a month, the wallet-funding flow has a UX gap
  worth a separate ticket.
- Document the compensation in the user's support ticket so future
  reviewers see the closed loop.
