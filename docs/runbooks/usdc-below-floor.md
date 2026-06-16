# Runbook · `notifyUsdcBelowFloor` alert

## Symptom

Discord `#ops-alerts` embed titled **"🟡 USDC Reserve Below Floor"** from
`notifyUsdcBelowFloor`.

## Severity

**P2** by default. Procurement can fall back to XLM, but the preferred rail is degraded.

## Diagnosis

1. Derive the operator account id. There is **no** `LOOP_STELLAR_OPERATOR_ID`
   env var — the public key is derived from the secret signer
   (`LOOP_STELLAR_OPERATOR_SECRET`, the account procurement pays USDC from).
   The embed's `Account` field already carries it (last-8 truncated); for the
   full `G…` id, derive it from the secret on a trusted machine:

   ```bash
   OPERATOR_PUBKEY=$(fly ssh console -a loopfinance-api -C \
     "node -e \"const{Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromSecret(process.env.LOOP_STELLAR_OPERATOR_SECRET).publicKey())\"")
   echo "$OPERATOR_PUBKEY"
   ```

   (`/health` also reports the active operator account id — see
   [`stellar-operator-rotation.md`](./stellar-operator-rotation.md).)

2. Confirm the balance on Horizon:
   ```bash
   curl -s "https://horizon.stellar.org/accounts/$OPERATOR_PUBKEY" | jq '.balances'
   ```
3. Confirm the configured floor (the var name includes `STELLAR`):
   ```bash
   fly secrets list -a loopfinance-api | grep LOOP_STELLAR_USDC_FLOOR_STROOPS
   ```

## Mitigation

Top up the operator account's USDC balance from treasury. Procurement switches back automatically on the next healthy read.

## Resolution

Close once a fresh balance read is above `LOOP_STELLAR_USDC_FLOOR_STROOPS` and no further below-floor alerts fire.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md)
