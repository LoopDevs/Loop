# Runbook · `notifyPaymentWatcherStuck` alert

## Symptom

Discord `#ops-alerts` embed titled **"🔴 Payment Watcher Cursor Stuck"** from
`notifyPaymentWatcherStuck`.

## Severity

**P1.** Fresh deposits are not being observed, so paid orders stop advancing.

## Diagnosis

1. Check the cursor age from the alert and confirm it in logs:
   ```bash
   fly logs -a loopfinance-api | grep "Payment watcher" | tail -50
   ```
2. Check `/health` for `workers[] | select(.name=="payment_watcher")`.
3. Verify Horizon reachability:
   ```bash
   curl -s https://horizon.stellar.org/health
   ```
4. Verify the cursor row is still writable:
   ```sql
   SELECT name, cursor, updated_at FROM watcher_cursors WHERE name='stellar-deposits';
   ```

## Mitigation

- Horizon down: wait for recovery; the next healthy tick clears the stuck period.
- Cursor-write failure or crashed worker: restart the backend machine.
- Repeated stalls after restart: treat as a backend bug and page maintainers.

## Resolution

The incident is closed when the cursor advances again and `/health` no longer marks `payment_watcher` degraded.

## Related

- [`health-degraded.md`](./health-degraded.md)
- [`operator-pool-exhausted.md`](./operator-pool-exhausted.md)
