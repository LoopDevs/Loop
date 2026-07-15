# FT-02 — Soroban aged-out NOT_FOUND double-mint (HELD — needs coordinated multi-file + migration fix)

**Severity: HIGH (double-mint / operator USDC loss).** Held because the correct fix touches a schema migration + on-chain idempotency threading across 4 files — protected classes + delicate crash-safety timing that warrants human-coordinated implementation.

**Root cause (verified, reproduces):** `checkPriorSorobanTx` (soroban-submit.ts) collapsed getTransaction NOT_FOUND and FAILED into `{landed:false}`. Soroban RPC retains tx history for a bounded window; a deposit that LANDED but whose row didn't advance (process crash post-land), retried days later after the RPC history aged out, gets NOT_FOUND → treated as never-landed → fresh re-submit → **second deposit lands → double-mint**.

**Groundwork done (in `held/FT-02-soroban-double-mint.patch`, inert until wired):** soroban-submit.ts now disambiguates NOT_FOUND using `oldestLedger` (from the RPC) vs a `submittedLedger` lower bound (`sim.latestLedger`): if the landing window is pruned (`oldestLedger > submittedLedger`) it fails closed; otherwise NOT_FOUND is authoritative never-landed and retries. Proven red at the unit layer; full suite 3929 green; zero runtime change to existing callers (none pass the new param yet).

**Remaining coordination (for a human/coordinated session):**

1. **Migration**: `vault_emissions` + `vault_redemptions` add `*_submitted_ledger` columns.
2. **vault-client.ts**: thread `priorTxSubmittedLedger` into deposit/transfer/redemption args + re-expose `result.submittedLedger`; pass into `checkPriorSorobanTx` (line ~512).
3. **vault-emissions.ts / vault-redemptions.ts**: persist `result.submittedLedger`, pass back as `priorTxSubmittedLedger`.
4. **Crash-safety**: extend the CF-18 `onSigned` hook to deliver `(txHash, submittedLedger)` so the ledger is persisted with the hash _before_ send (the double-mint window is a crash after land but before result-persist).
