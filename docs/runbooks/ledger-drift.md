# Runbook · Ledger drift detected

## Symptom

- Output of `npm run -w @loop/backend check:ledger` (the post-deploy
  smoke from A2-1519) is non-zero.
- `/api/admin/reconciliation` returns rows with `ledgerSumMinor !=
balanceSumMinor` for a `(user_id, currency)` pair.
- Discord alert from the reconciliation job: "ledger drift detected: N
  rows differ".

## Severity

- **P0** for any single drift entry > 100 minor units (≥$1.00).
  Money is moving incorrectly somewhere; stop further admin writes
  until traced.
- **P1** for sub-dollar drift across many rows (likely a rounding bug,
  not a stolen-money scenario).
- **P2** for a single sub-dollar drift on one user (could be a
  legitimate accrual mid-write — re-run after 60s).

## Diagnosis

1. **Re-run the check.** A single rapid-fire reconciliation can race
   against an in-flight credit transaction:
   ```bash
   npm run --workspace=@loop/backend check:ledger
   ```
2. **Pull the offending pair(s):**
   ```bash
   curl -sH "Authorization: Bearer $ADMIN_TOKEN" https://api.loopfinance.io/api/admin/reconciliation | jq '.rows[] | select(.ledgerSumMinor != .balanceSumMinor)'
   ```
3. **For each drift row, dump the credit-transactions in time order:**
   ```bash
   psql "$DATABASE_URL" <<SQL
   SELECT id, type, amount_minor, currency, reference_type, reference_id, period_cursor, created_at
   FROM credit_transactions
   WHERE user_id = '<user-id>' AND currency = '<currency>'
   ORDER BY created_at;
   SQL
   ```
   Compare the running sum against `user_credits.balance_minor` for
   the same pair. The drift is the row(s) where the divergence first
   appears.
4. **Check for orphans** (a balance row with no ledger trail or vice
   versa). Both surface in the reconciliation endpoint's `rows[]`
   output as "orphan" rather than "drift".

## Mitigation

| Pattern                                           | Action                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single mid-write race; second run shows no drift  | Race resolved itself. Note the row + timestamp; no incident.                                                                                                                 |
| Real drift on a specific user                     | **Stop new admin writes** for the affected user until traced (block in the admin panel via a per-user disable flag if that exists; otherwise verbal-stop in `#admin-audit`). |
| Drift across many users for one currency          | A migration / accrual job has a bug. Disable workers (`fly secrets set LOOP_WORKERS_ENABLED=false`) until the accrual code is reviewed.                                      |
| Orphan balance row (balance > 0, no ledger trail) | Immediate **incident — possible attacker-write to user_credits without ledger**. Audit DB write logs. Roll-forward fix is admin-write a corrective ledger row to match.      |
| Orphan ledger row (ledger > 0, no balance row)    | Less serious — balance was lost on a delete-cascade or migration. Roll-forward by `INSERT INTO user_credits` with the matching ledger sum.                                   |

## Resolution

After tracing the cause:

- **Money flow bug**: write the fix, deploy, re-run reconciliation. If
  the drift was negative (we owed the user), file a balance correction
  via the admin adjustment endpoint with a `reason` citing this
  runbook.
- **Migration / accrual bug**: revert via a follow-up migration or
  hot-fix the worker. Run reconciliation post-deploy.
- **Attacker write (orphan-balance scenario)**: rotate DB credentials,
  audit recent connections, write up the incident.

## Post-mortem

- **P0 always.** Money-flow incidents document everything.
- For race-and-self-resolve: a one-line note in the change log; no
  post-mortem.

## References

- ADR 009 (credits ledger) — invariant: `sum(credit_transactions) ==
user_credits.balance_minor`, per (user, currency).
- `apps/backend/src/credits/ledger-invariant.ts` — single source of
  truth for the drift computation; both the API endpoint and the
  CLI smoke read from this module (audit A2-1519).
- `scripts/check-ledger-invariant.ts` — the CLI invocation the
  post-deploy smoke runs.
