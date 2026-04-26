# Runbook · `notifyAssetDrift` alert (Discord `#ops-alerts`)

## Symptom

`#ops-alerts` Discord embed titled **"⚠️ Asset Drift Exceeded
Threshold"** with fields:

- `Asset` — `USDLOOP` / `GBPLOOP` / `EURLOOP`
- `Drift (stroops)` — signed (negative = settlement backlog,
  positive = over-minted)
- `Threshold (stroops)` — `LOOP_ASSET_DRIFT_THRESHOLD_STROOPS`
- `On-chain (stroops)` — Horizon-reported circulation
- `Ledger (minor)` — sum of `user_credits.balance_minor` for that
  asset's matching home currency

Source: `apps/backend/src/discord.ts::notifyAssetDrift` — fires
once on each ok→over transition (in-memory dedupe at the watcher).
The sibling `notifyAssetDriftRecovered` fires on over→ok so every
drift incident gets a beginning AND an end in the channel.

## What "drift" means

Drift = on-chain circulation − off-chain ledger liability (in
matching units). Two failure modes:

| Sign  | Direction              | Meaning                                                                                                                                                                      |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **+** | **Over-minted**        | More LOOP asset is circulating on Stellar than the ledger says we owe. We've issued tokens that aren't backed by a matching off-chain liability. **Critical financial bug.** |
| **−** | **Settlement backlog** | Ledger owes more cashback than has actually been minted on-chain. Submit worker has a backlog or a bug; users are owed payouts that haven't landed.                          |

ADR 015 §"Drift safety" pins the invariant: **on-chain MUST always
equal ledger** at steady-state, modulo a small in-flight tolerance
(`LOOP_ASSET_DRIFT_THRESHOLD_STROOPS`, default 100 LOOP = 10⁹
stroops, set higher in dev / lower in prod).

## Severity

| Direction                | Severity | SLA                                                                                                                     |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Over-minted (`+`)        | **P0**   | This is unbacked liability. ACK in 5 min, mitigate in 30 min — kill the affected asset's submit worker until diagnosed. |
| Settlement backlog (`−`) | **P1**   | Users are owed money but the loss is bounded by the backlog size. ACK in 30 min, mitigate same-day.                     |

## Triage (first 10 minutes)

1. **Read both numbers.** `On-chain` and `Ledger` should be roughly
   equal. The drift is the discrepancy. Direction matters more than
   magnitude.
2. **Cross-check on Horizon directly.** Don't trust just the embed
   — Horizon `/assets?asset_code=<CODE>&asset_issuer=<G…>` returns
   the canonical `amount`. If Horizon disagrees with the embed, the
   watcher's read is stale; refresh and re-evaluate.
3. **Sum the ledger directly.**
   ```sql
   SELECT SUM(balance_minor) FROM user_credits WHERE currency='<USD|GBP|EUR>';
   ```
   If this disagrees with the embed too, the watcher computation is
   compromised; that's its own bug.
4. **Identify recent activity.** Has there been a manual mint
   (operator topped up the asset issuer)? A burst of payouts? A
   ledger import? Any of these can transiently push drift past the
   threshold during the activity, recovering naturally afterwards.

## Mitigation

### Over-minted (P0) — immediate

1. **Stop minting.** The submit worker is the mint surface — kill
   it for the affected asset:
   ```bash
   fly secrets set LOOP_WORKERS_ENABLED=false -a loopfinance-api
   ```
   This halts ALL workers (per ADR 016) — broader than needed but
   safe. (A per-asset kill is a Phase-2 polish.)
2. **Identify the over-minted source.** Either:
   - A bug in the submit worker minted twice for the same payout
     (check `pending_payouts` for duplicate `tx_hash` rows that
     each landed)
   - A manual mint that wasn't paired with a corresponding ledger
     liability row
3. **Burn the excess** by sending it back to the issuer account
   (which destroys it for non-asset-issuer Stellar accounts). Get
   a second signer on the operator key per ADR 016 multisig posture.
4. **Re-enable workers** once the on-chain matches the ledger.

### Settlement backlog (P1)

1. Check if the submit worker is healthy. Look for `op_*` errors
   in `pending_payouts.last_error`:
   ```sql
   SELECT last_error, COUNT(*) FROM pending_payouts WHERE state='pending' GROUP BY last_error;
   ```
2. If most are `op_underfunded` referring to the **operator** (not
   the destination): top up the operator's holdings of the asset
   (Defindex deposit; manual today per A2-204). Workers will drain
   the backlog automatically once funded.
3. If most are user-side errors (`op_no_trust`, etc.): each one
   needs the user to fix their wallet — the backlog will drain
   slowly as users add trustlines. Not really an "incident", just a
   measurement of UX gap.
4. If the worker is healthy and the rows are clean `pending` →
   wait. The backlog drains at the worker's tick rate. If the
   threshold breach is small and recovering, no action needed.

## Resolution

The `notifyAssetDriftRecovered` sibling fires on the over→ok
transition automatically — that's the channel-side closure marker.
For P0 incidents, post a manual `✅` message tagging the cause +
the burn / mint correction transaction hash before walking away.

## Post-mortem

- **Always** for over-minted (P0). Two-signer review: how did
  unbacked tokens enter circulation. Track recurrences via the
  drift-by-asset audit table (A2-1505).
- **For prolonged settlement backlog** (>4h sustained over-threshold)
  → file a worker-throughput ticket. Single-signer scaling on the
  operator account becomes the bottleneck above ~10/sec; multi-signer
  parallelism is a Phase-2 lever.

## Related

- [`stellar-operator-rotation.md`](./stellar-operator-rotation.md)
  — if the operator signer is implicated.
- [`payout-failed-alert.md`](./payout-failed-alert.md) — sibling
  alert on per-payout failures (vs aggregate drift).
- ADR 015 §"Drift safety" — the invariant this alert defends.
- ADR 016 §"Operator multisig" — the procedure for two-signer
  burns / mints.
