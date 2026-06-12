# Wallet provisioning stuck (`notifyWalletProvisioningStuck`)

## Symptom

Discord `#loop-monitoring` shows **🔴 Wallet Provisioning Stuck** with a
user id (last 8), provisioning state (`none` / `wallet_created`), the
wallet id + address when present, and `attempts: 10`. The
wallet-provisioning sweeper (ADR 030 Phase C1) has failed 10 drives for
this user and stopped retrying.

User impact: they can still browse and buy — only **on-chain cashback
payouts** wait on the wallet (the payout builder falls back to a legacy
linked `stellar_address`, or skips and the liability stays mirrored in
`user_credits`). "Pay with Loop balance" returns `WALLET_NOT_ACTIVATED`.

## Severity

P2 — single-user, no funds at risk (cashback liability is preserved
off-chain). Many alerts in a short window = a systemic failure
(provider auth, operator account, Horizon) → treat as P1.

## Diagnosis (~5 min)

1. Which step is stuck? `wallet_provisioning` on the row says it:

   ```sql
   SELECT id, wallet_provider, wallet_id, wallet_address,
          wallet_provisioning, wallet_provisioning_attempts,
          wallet_provisioning_last_attempt_at
   FROM users WHERE id = '<user-id>';
   ```

   - `none` + `wallet_id IS NULL` → **createWallet** failing → Privy-side.
   - `wallet_created` → **activation** failing → Stellar-side.

2. Backend logs (`area: 'wallet-provisioning'`) carry the per-drive
   error: `flyctl logs -a loopfinance-api | grep wallet-provisioning`.

3. Privy-side checks: app credentials valid (`PRIVY_APP_ID` /
   `PRIVY_APP_SECRET` in `flyctl secrets list`), Privy status page,
   wallet visible in the Privy dashboard under the user's `external_id`
   (= Loop user uuid).

4. Stellar-side checks: operator account funded + reachable
   (`https://horizon.stellar.org/accounts/<operator>`), the user
   account's current state
   (`/accounts/<wallet_address>` — 404 = never created), recent
   `tx_failed` submissions from the operator account.

## Mitigation

The sweeper has stopped (attempts ≥ 10). After fixing the root cause,
re-arm the row — or use the admin UI:
`POST /api/admin/users/:userId/wallet/reprovision` (ADR 037; audited,
resets the budget AND re-enqueues the drive immediately, support-tier).
The SQL equivalent resets the budget only:

```sql
UPDATE users
SET wallet_provisioning_attempts = 0,
    wallet_provisioning_last_attempt_at = NULL
WHERE id = '<user-id>' AND wallet_provisioning <> 'activated';
```

The next sweeper tick (60s) re-drives it. Activation is idempotent:
if a prior submit actually landed (crash between submit and persist),
the drive detects the live account + trustlines on Horizon and just
marks the row `activated` — it never double-creates.

## Resolution

- **Privy 401/403** → rotate/fix the app secret, redeploy secrets.
- **Operator underfunded** (`op_underfunded` on createAccount fee /
  sponsorship) → top up the operator account's XLM.
- **`op_bad_auth` / signature mismatch** → the provider returned a
  signature that doesn't verify; the Phase-B bridge refuses it
  pre-submit. Check the wallet still exists provider-side and the
  address column matches the provider's record.
- **Horizon outage** → wait it out; reset attempts after recovery.

## Post-mortem

Not required for single-user P2. Required if a systemic cause
(credentials, operator account) burned the retry budget across many
users — the budget reset above must then be run fleet-wide:

```sql
UPDATE users
SET wallet_provisioning_attempts = 0
WHERE wallet_provisioning <> 'activated'
  AND wallet_provisioning_attempts >= 10;
```
