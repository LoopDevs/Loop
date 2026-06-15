# Runbook · `notifyInterestPoolLow` alert (Discord `#ops-alerts`)

## Symptom

`#ops-alerts` Discord embed titled **"🟠 Interest pool running low"** with
fields:

- `Asset` — `USDLOOP` / `GBPLOOP` / `EURLOOP`
- `Pool (stroops)` — current on-chain balance of the forward-mint pool
- `Daily interest (stroops)` — current forecast daily accrual for that asset
- `Days of cover` — `Pool / Daily interest`
- `Minimum` — `LOOP_INTEREST_POOL_MIN_DAYS_COVER` (default 7)

Source: `apps/backend/src/discord/monitoring.ts::notifyInterestPoolLow`,
fired by the interest-pool watcher
(`apps/backend/src/payments/interest-pool-watcher.ts`). It fires **once per
asset** on the ok→low transition (in-memory dedupe); the paired
`notifyInterestPoolRecovered` ("✅ Interest pool replenished") fires on the
low→ok transition so every depletion gets a beginning and an end.

## What the pool is

Per the on-chain-is-source-of-truth model (ADR 009 / 015), paying users
daily interest creates new off-chain `user_credits` liability that must be
matched by an on-chain LOOP-asset mint. To avoid one mint tx per day per
currency, the operator pre-mints a **forward batch** (typically a month of
expected interest) into the pool account (`LOOP_INTEREST_POOL_ACCOUNT`,
defaults to the operator account). Daily accrual then sub-allocates from the
pool off-chain. When the pool's remaining balance covers fewer than
`LOOP_INTEREST_POOL_MIN_DAYS_COVER` days, this alert fires so the operator
mints the next batch before users would be under-allocated.

## Severity

**P2** — the on-chain mint is a money-moving step, but there is runway
(`Days of cover` ≥ 0 and at least the threshold's lead time was configured
to allow a mint). ACK same business day; mint before `Days of cover`
reaches 0. Treat as **P1** if `Days of cover` is already < 1.

## Diagnosis (first 10 minutes)

1. **Read the embed.** `Days of cover` and `Asset` tell you how much runway
   is left and which LOOP asset needs minting.
2. **Confirm the pool balance on Horizon.** Derive the pool account
   (defaults to the operator account when `LOOP_INTEREST_POOL_ACCOUNT` is
   unset — see `apps/backend/src/env.ts`):
   ```bash
   # Run from apps/backend so the @stellar/stellar-sdk dep resolves.
   # If LOOP_INTEREST_POOL_ACCOUNT is set, use that G... address directly.
   # Otherwise the pool IS the operator account:
   POOL_PUBKEY=${LOOP_INTEREST_POOL_ACCOUNT:-$(node -e "import('@stellar/stellar-sdk').then(s => console.log(s.Keypair.fromSecret(process.env.LOOP_STELLAR_OPERATOR_SECRET).publicKey()))")}
   curl -s "https://horizon.stellar.org/accounts/$POOL_PUBKEY" | jq '.balances'
   ```
   Find the balance line for the affected asset code; it should match the
   embed's `Pool (stroops)` (÷10⁷ for whole units).
3. **Sanity-check the daily forecast.** `Daily interest (stroops)` is driven
   by current `user_credits` balances × `INTEREST_APY_BASIS_POINTS`. A sudden
   jump (large new balances) shortens cover faster than a steady state.

## Mitigation — mint the next batch

1. **Compute the batch size.** A month of cover is the usual cadence:
   `batch_stroops ≈ Daily interest (stroops) × 30`. Round up; a larger batch
   means fewer mints, but the drift watcher subtracts the pool balance from
   on-chain circulation before comparing to liability (ADR 015), so a fresh
   over-pool does **not** trip the over-issued drift alert.
2. **Mint into the pool account** for the affected LOOP asset, signed from
   the asset issuer (ADR 015 / 016). The destination is the pool account
   from step 2 (operator account unless `LOOP_INTEREST_POOL_ACCOUNT` is
   set). Use the two-signer posture per ADR 016 for the issuer key.
3. **Verify the mint cleared.** Re-run the Horizon balance read from
   Diagnosis step 2; the asset balance should rise by `batch_stroops`. The
   watcher re-evaluates on its next tick
   (`LOOP_ASSET_DRIFT_WATCHER_INTERVAL_SECONDS` cadence for drift; the pool
   watcher on its own interval) and `Days of cover` should jump back above
   `Minimum`.

## Resolution

The paired `notifyInterestPoolRecovered` ("✅ Interest pool replenished")
fires automatically on the next watcher tick once `Days of cover` is back
above `LOOP_INTEREST_POOL_MIN_DAYS_COVER` — that is the channel-side closure
marker. Post the mint `tx_hash` in `#ops-alerts` alongside it so the team
sees what was minted and where.

## Post-mortem

- Routine top-ups don't need one. Write one only if the pool actually
  reached **0 days of cover** (users were under-allocated) — that means the
  threshold lead time was too short for the mint turnaround. Raise
  `LOOP_INTEREST_POOL_MIN_DAYS_COVER` and document the mint SLA.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md) — the drift watcher
  subtracts the pool balance before comparing on-chain to liability, so a
  fresh mint into the pool is drift-neutral.
- [`stellar-operator-rotation.md`](./stellar-operator-rotation.md) — if the
  issuer/operator signer is implicated.
- ADR 009 / 015 §interest forward-mint pool — the topology this alert
  defends.
