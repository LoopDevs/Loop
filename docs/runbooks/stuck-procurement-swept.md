# Runbook · `notifyStuckProcurementSwept` alert

## Symptom

Discord `#ops-alerts` embed titled **"🟡 Stuck Procuring Order Swept to Failed"** from
`notifyStuckProcurementSwept`.

## Severity

**P1** if the row may already have been procured upstream. Otherwise **P2**.

## Diagnosis

1. Pivot from the alert's order id into `/api/admin/orders/:orderId`.
2. Check CTX-side procurement status for the same operator/order.
3. Confirm whether the user was charged and whether a gift card was minted upstream.

## Mitigation

- If CTX minted the card: do not refund automatically. Reconcile first, then deliver or compensate deliberately.
- If CTX never minted the card: process the refund path and close the failed order cleanly.

## Resolution

Post the row outcome in `#ops-alerts`: reconciled-and-delivered, refunded, or awaiting CTX confirmation.

## Related

- [`operator-pool-exhausted.md`](./operator-pool-exhausted.md)
- [`ctx-circuit-open.md`](./ctx-circuit-open.md)
