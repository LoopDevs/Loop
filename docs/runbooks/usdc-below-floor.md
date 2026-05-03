# Runbook · `notifyUsdcBelowFloor` alert

## Symptom

Discord `#ops-alerts` embed titled **"🟡 USDC Reserve Below Floor"** from
`notifyUsdcBelowFloor`.

## Severity

**P2** by default. Procurement can fall back to XLM, but the preferred rail is degraded.

## Diagnosis

1. Confirm the balance on Horizon:
   ```bash
   curl -s "https://horizon.stellar.org/accounts/$LOOP_STELLAR_OPERATOR_ID" | jq '.balances'
   ```
2. Confirm the configured floor:
   ```bash
   fly secrets list -a loopfinance-api | grep LOOP_USDC_FLOOR_STROOPS
   ```

## Mitigation

Top up the operator account's USDC balance from treasury. Procurement switches back automatically on the next healthy read.

## Resolution

Close once a fresh balance read is above `LOOP_USDC_FLOOR_STROOPS` and no further below-floor alerts fire.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md)
