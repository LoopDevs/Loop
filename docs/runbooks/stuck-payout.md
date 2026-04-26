# Runbook · Stuck payout

## Symptom

- Discord `#ops-alerts` ping from `payout-watchdog`: a `pending_payouts`
  row has been in `state='pending'` or `state='submitted'` for longer
  than the watchdog window (default 5 min).
- A user-support ticket: "I haven't received my cashback yet" with an
  order id older than ~10 minutes.
- `/admin/payouts?state=pending` or `?state=submitted` shows rows older
  than the SLO.

## Severity

- **P2** by default — the user's balance is intact (off-chain ledger
  reflects the entitlement); only the on-chain payout is delayed.
- **P1** if more than 20 rows are stuck simultaneously (likely a
  per-asset issue or operator-secret problem, not an isolated row).

## Diagnosis

1. Open `/admin/payouts/<id>` in the admin panel for a specific stuck
   row. Confirm `state`, `attempts`, `lastError`, `txHash`. Tx hash
   present → submitted but never confirmed (Horizon read failure or
   `payment-watcher` lag, not a submit-side problem).
2. From a bastion / local with `DATABASE_URL` set:
   ```bash
   psql "$DATABASE_URL" -c "SELECT id, state, attempts, last_error, submitted_at, NOW() - submitted_at AS age FROM pending_payouts WHERE state IN ('pending', 'submitted') ORDER BY created_at LIMIT 20;"
   ```
3. Check the payout-submit worker log on Fly:
   ```bash
   fly logs -a loopfinance-api | grep -E "payout-submit|payout-watchdog" | tail -50
   ```
4. Check operator account funding on Horizon:
   ```bash
   curl -s "https://horizon.stellar.org/accounts/$LOOP_STELLAR_OPERATOR_ID" | jq '.balances'
   ```
   Operator balance below the per-asset floor → submit will keep
   failing with `op_underfunded` until refilled.

## Mitigation

| Cause                                    | First action                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Operator unfunded (`op_underfunded`)     | Top up the operator account from cold storage. Worker auto-retries on next tick.                                    |
| Destination has no trustline             | Wait — `payment-watcher` will catch the trustline once the user adds it. Manual `compensate` if user can't add one. |
| Worker disabled (`LOOP_WORKERS_ENABLED`) | `fly secrets set LOOP_WORKERS_ENABLED=true -a loopfinance-api`. Workers come up on next deploy / machine restart.   |
| Horizon outage                           | Check Stellar Status (`status.stellar.org`). Wait. Worker retries with exponential backoff.                         |
| Single specific row that won't drain     | Admin panel `/admin/payouts/:id` → Retry button. Requires reason (≥2 chars). Audit-logged to `#admin-audit`.        |

## Resolution

Most stuck payouts drain on their own once the upstream cause clears.
The watchdog re-claims any row stuck in `submitted` for >5 min and
re-submits with idempotency-by-memo so a double-pay is impossible
(ADR 016).

For permanent failures (destination doesn't exist, retryable Horizon
errors exhausted), see [`payout-permanent-failure.md`](./payout-permanent-failure.md).

## Post-mortem

- ≥20 stuck rows simultaneously → P1 → write a post-mortem.
- Operator-funding drained without alert → product gap (alerting), not
  just a stuck payout. File a ticket against the alerting docs.
- Same row needs manual retry twice → escalate; idempotency is supposed
  to make this a no-op.
