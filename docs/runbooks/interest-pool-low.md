# Runbook — 🟠 Interest pool running low

**Alert source:** `notifyInterestPoolLow`
(`apps/backend/src/discord/monitoring.ts`), fired by the interest-pool
cover check in `apps/backend/src/payments/interest-pool-watcher.ts` on
the monitoring channel (`DISCORD_WEBHOOK_MONITORING`). The paired
close-out alert is `notifyInterestPoolRecovered` ("✅ Interest pool
replenished").

**What it means:** the on-chain forward-mint pool for a LOOP asset
(ADR 009 / ADR 015) holds fewer than `LOOP_INTEREST_POOL_MIN_DAYS_COVER`
days (default 7) of forecast daily interest. Daily interest accrual
sub-allocates off-chain from a pre-minted on-chain batch in the pool
account; when the pool runs dry, new off-chain interest liability would
have no on-chain backing, which the asset-drift watcher would then flag.
**The operator action is an on-chain mint** of the next batch into the
pool account.

## Severity

**P2.** Self-bounded — there are still `daysOfCover` days before users
would be under-allocated — but the remediation is a money-affecting mint
that should not wait until the pool is empty. ACK same-day; mint before
cover reaches ~1 day.

> **Phase-1 note:** interest accrual is gated
> (`INTEREST_APY_BASIS_POINTS=0` + `LOOP_WORKERS_ENABLED=false` by
> default), so this alert is **gated** to cashback/interest mode. If it
> fires in Phase 1, check those gates first.

## Triage (first 10 minutes)

1. Read the embed: `Asset`, `Pool (stroops)`, `Daily interest
(stroops)`, `Days of cover`, `Minimum`. `Days of cover` ≈
   `Pool / Daily interest`.
2. Identify the pool account and issuer. The pool account is
   `LOOP_INTEREST_POOL_ACCOUNT` (defaults to the operator account when
   unset). The issuer is the per-asset `LOOP_STELLAR_*LOOP_ISSUER`.
   ```bash
   fly secrets list -a loopfinance-api | grep -E 'LOOP_INTEREST_POOL_ACCOUNT|LOOP_STELLAR_.*LOOP_ISSUER|LOOP_INTEREST_POOL_MIN_DAYS_COVER|INTEREST_APY_BASIS_POINTS'
   ```
3. Confirm the on-chain pool balance directly on Horizon (don't trust
   only the embed):
   ```bash
   curl -s "https://horizon.stellar.org/accounts/$LOOP_INTEREST_POOL_ACCOUNT" | jq '.balances'
   ```

## Resolution — mint the next batch

1. **Compute the batch size.** Target a comfortable cover window (e.g.
   30 days), so `batch_stroops = daily_interest_stroops × target_days −
current_pool_stroops`. Round up. The embed's `Daily interest
(stroops)` is the forecast input.
2. **Mint from the asset issuer to the pool account.** Submit a
   `Payment` op from the issuer of the affected asset
   (`LOOP_STELLAR_*LOOP_ISSUER`) to `LOOP_INTEREST_POOL_ACCOUNT` for
   `batch_stroops`, signed by the issuer signer on a trusted machine.
   Use `@stellar/stellar-sdk` (never the Web Crypto API for Stellar
   signing). This increases on-chain circulation to match the off-chain
   interest liability being accrued.
3. **Verify the mint cleared.** Re-read the pool balance on Horizon and
   confirm it rose by `batch_stroops`. The next watcher tick will then
   fire `notifyInterestPoolRecovered` once cover is back above the
   minimum.

Post the asset, batch size, tx hash, and new cover in `#ops-alerts`
(no silent mints).

## Afterwards

- Record the mint in the monthly reconciliation sheet
  (`monthly-reconciliation.md`) — it is an on-chain issuance event that
  the asset-drift reconciliation must be able to explain.
- If a pool depletes faster than forecast, revisit
  `LOOP_INTEREST_POOL_MIN_DAYS_COVER` or the batch sizing rather than
  re-minting reactively each week.

## Related

- [`asset-drift-alert.md`](./asset-drift-alert.md) — drift the watcher
  would report if the pool ran dry and interest accrued unbacked.
- [`monthly-reconciliation.md`](./monthly-reconciliation.md)
