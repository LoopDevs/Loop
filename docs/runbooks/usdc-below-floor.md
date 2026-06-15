# Runbook · `notifyUsdcBelowFloor` alert

## Symptom

Discord `#ops-alerts` embed titled **"🟡 USDC Reserve Below Floor"** from
`notifyUsdcBelowFloor`.

## Severity

**P2** by default. Procurement can fall back to XLM, but the preferred rail is degraded.

## Diagnosis

1. Derive the operator account's public key from its secret. There is no
   `LOOP_STELLAR_OPERATOR_ID` env var — the account ID is derived from
   `LOOP_STELLAR_OPERATOR_SECRET` (`apps/backend/src/env.ts`):
   ```bash
   # Run from apps/backend so the @stellar/stellar-sdk dep resolves.
   # Reads LOOP_STELLAR_OPERATOR_SECRET from the environment (never printed).
   OPERATOR_PUBKEY=$(node -e "import('@stellar/stellar-sdk').then(s => console.log(s.Keypair.fromSecret(process.env.LOOP_STELLAR_OPERATOR_SECRET).publicKey()))")
   ```
2. Confirm the balance on Horizon:
   ```bash
   curl -s "https://horizon.stellar.org/accounts/$OPERATOR_PUBKEY" | jq '.balances'
   ```
3. Confirm the configured floor:
   ```bash
   fly secrets list -a loopfinance-api | grep LOOP_STELLAR_USDC_FLOOR_STROOPS
   ```

## Mitigation

Top up the operator account's USDC balance from treasury. Procurement switches back automatically on the next healthy read.

## Resolution

Close once a fresh balance read is above `LOOP_STELLAR_USDC_FLOOR_STROOPS` and no further below-floor alerts fire.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md)
