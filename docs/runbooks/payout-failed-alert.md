# Runbook · `notifyPayoutFailed` alert (Discord `#ops-alerts`)

## Symptom

`#ops-alerts` Discord embed titled **"🔴 Stellar Payout Failed"**
with fields:

- `Kind` — `order_cashback`, `emission`, or `burn` (ADR 036)
- `Asset` — `USDLOOP` / `GBPLOOP` / `EURLOOP`
- `Amount` — stroops (1 LOOP = 10⁷ stroops)
- `Attempts` — number of submit retries before this terminal failure
- `User` — last-8 of `users.id`
- `Order` — last-8 of `orders.id` (`_emission_` for ADR-024/036 rows)
- `Payout` — last-8 of `pending_payouts.id`
- `Reason` — Stellar error code (`op_no_trust`, `op_no_destination`,
  `op_underfunded`, `op_line_full`, …) or a transient retry-exhaust

Source: `apps/backend/src/discord.ts::notifyPayoutFailed` — fires
once per row entering terminal `state='failed'` from the submit
worker (ADR 016).

## Severity

| Kind             | Severity | Why                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emission`       | **P1**   | LEGACY pre-ADR-036 rows: the user's balance was debited at send (ADR-024 §3) but the payout never landed — they're owed money. Same-day response. Post-ADR-036 emissions carry no debit but the user is still awaiting an owed on-chain backfill.                                                       |
| `burn`           | **P1**   | A redemption's issuer-return failed (ADR 036): the mirror is already debited and the received LOOP is stranded at the deposit account, so the drift watcher's in-flight-burn term stays elevated. Operator-side only — the destination is our own issuer, so failures imply config or Horizon problems. |
| `order_cashback` | **P2**   | Order was fulfilled and the cashback is owed; the user expects an on-chain top-up that hasn't arrived. Next-business-day OK.                                                                                                                                                                            |

Bump severity by one tier if `Attempts >= 5` AND the same
`(userId, reason)` pair has fired more than once in 24h — this is a
pattern, not a one-off.

## Triage (first 5 minutes)

1. **Tail-id pivot.** The Discord embed only carries last-8 ids per
   ADR-018. Open `/admin/payouts?suffix=<last-8>` to find the full
   row, or query directly:
   ```sql
   SELECT * FROM pending_payouts WHERE id::text LIKE '%<last-8>';
   ```
2. **Classify the reason.** The remediation depends entirely on
   whether it's:
   - **User-side** (`op_no_trust`, `op_no_destination`,
     `op_line_full`) — the user's wallet is the gate; they need to
     add a trustline / recreate the account / clear room.
   - **Operator-side** (`op_underfunded` referring to the operator,
     not the destination — check Horizon for the operator account's
     balance) — Loop's operator doesn't have enough of the asset to
     send. Mint or top up; cross-ref `payout-permanent-failure.md`.
   - **Transient retry-exhaust** (no `op_*` code; raw text like
     "timeout" or "connection refused" with high `attempts`) — the
     network-or-Horizon path was bad through the whole retry window.
     Re-queue once Horizon recovers.

## Mitigation

### Emission (`kind='emission'`)

- **Legacy pre-ADR-036 row** (a `type='withdrawal'` ledger debit
  references the payout id): run the compensation flow from
  [`payout-permanent-failure.md` §legacy-emission](./payout-permanent-failure.md#kindemission-legacy--compensate).
  Result: user's balance restored, they can re-request once their
  wallet is fixed.
- **Post-ADR-036 emission** (no debit row): there is nothing to
  compensate — the mirror was never touched. Fix the user-side or
  operator-side cause and re-queue via `/admin/payouts/<id>/retry`,
  or re-issue a fresh emission to a corrected address.

### Burn (`kind='burn'`)

The destination is the asset's own issuer, which always accepts its
asset back — `op_no_trust` / `op_no_destination` here mean the
pinned `asset_issuer` env var is wrong or the issuer account was
merged. Verify `LOOP_STELLAR_<CODE>_ISSUER`, then re-queue with
`/admin/payouts/<id>/retry`. Never compensate a burn: the mirror
debit it pairs with is correct; the burn just needs to land.

### Order cashback (`kind='order_cashback'`)

- **Trustline missing**: notify the user via support to add the
  matching LOOP asset trustline. Once it lands, the submit worker
  will pick the row up on the next `pending` re-queue (`/admin/payouts/<id>/retry`).
- **Account doesn't exist / line full / other terminal user-side**:
  follow [`payout-permanent-failure.md` §`kind='order_cashback'`](./payout-permanent-failure.md#kindorder_cashback--fix-root-cause)
  → admin refund flow (`POST /api/admin/users/:userId/refunds`).

### Operator-side underfunded

→ This is also covered by `notifyAssetDrift` (settlement-backlog
direction) — see [`asset-drift-alert.md`](./asset-drift-alert.md).
Top up the operator's holdings of the failed asset (Defindex
deposit; manual today, A2-204) and re-queue the row.

### Pure transient retry-exhaust

If Horizon is back up:

```sql
UPDATE pending_payouts SET state='pending', attempts=0, last_error=NULL WHERE id='<full-uuid>';
```

The submit worker picks it up on the next tick. No compensation
needed; the row will retry cleanly.

## Resolution

Close the incident in `#ops-alerts` with a single message:

```
✅ <last-8>  → <action taken>  (<owner-handle>)
```

For legacy emission failures, the compensation row `type='adjustment'`
referencing the payout id is the in-DB closure record (auditable
via `/admin/users/:userId` ledger drill).

## Post-mortem

- **Always** for any `kind='emission'` or `kind='burn'` failure —
  even a single one. The user-money trust gradient is real; failures
  in these classes eat trust faster than any other class of bug.
- **For repeats of the same `(reason, asset)`** pair → file a UX
  ticket. `op_no_trust` repeating means the trustline-prompt UX is
  failing — fix it upstream of the alert.

## Related

- [`payout-permanent-failure.md`](./payout-permanent-failure.md) —
  the broader procedure this alert is the firing signal for.
- [`asset-drift-alert.md`](./asset-drift-alert.md) — sibling alert
  when settlement backlog (operator underfunded) is the cause.
- [`stellar-operator-rotation.md`](./stellar-operator-rotation.md)
  — if the failure pattern is `op_underfunded` on the operator
  signer, the rotation runbook applies once the operator is rotated.
