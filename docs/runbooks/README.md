# Runbooks

Alert-response procedures for Loop's production surfaces. Each file
follows the same shape:

- **Symptom** — what the alert / Discord ping / customer report looks like
- **Severity** — P0/P1/P2/P3, and the response-target window
- **Diagnosis** — commands + dashboards to run before doing anything
- **Mitigation** — first-line action to stop the bleed
- **Resolution** — root-cause fix once mitigated
- **Post-mortem** — when it warrants one (P0/P1 always)

Pages are intentionally short. If a procedure starts taking >150 lines,
split it into a sub-page rather than padding.

## Indices

| Surface               | Runbooks                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payouts (Stellar)** | [stuck-payout.md](./stuck-payout.md) — pending_payouts row stuck pending/submitted                                                                                   |
|                       | [payout-permanent-failure.md](./payout-permanent-failure.md) — `op_no_destination`-class failure → admin compensation flow                                           |
|                       | [payout-failed-alert.md](./payout-failed-alert.md) — `notifyPayoutFailed` Discord alert triage (A2-1917)                                                             |
| **Asset drift**       | [asset-drift-alert.md](./asset-drift-alert.md) — `notifyAssetDrift` ok→over alert; over-minted (P0) vs settlement backlog (P1) (A2-1917)                             |
| **Operator pool**     | [operator-pool-exhausted.md](./operator-pool-exhausted.md) — `notifyOperatorPoolExhausted` — every CTX operator's circuit OPEN simultaneously (A2-1917)              |
| **Auth**              | [jwt-key-rotation.md](./jwt-key-rotation.md) — rotating `LOOP_JWT_SIGNING_KEY` without invalidating sessions                                                         |
| **Stellar signer**    | [stellar-operator-rotation.md](./stellar-operator-rotation.md) — quarterly + emergency rotation of `LOOP_STELLAR_OPERATOR_SECRET` (A2-1909)                          |
| **Mobile signing**    | [mobile-cert-renewal.md](./mobile-cert-renewal.md) — Apple/Google cert + provisioning + key renewal flow (A2-1908)                                                   |
| **Upstream (CTX)**    | [ctx-circuit-open.md](./ctx-circuit-open.md) — circuit breaker tripped on a CTX endpoint                                                                             |
| **Ledger**            | [ledger-drift.md](./ledger-drift.md) — `/api/admin/reconciliation` reports drift > threshold                                                                         |
|                       | [monthly-reconciliation.md](./monthly-reconciliation.md) — first-business-day procedure: CTX invoice ⇄ Loop `orders` ledger; per-merchant cross-check (A2-1914)      |
| **Operational gate**  | [kill-switch.md](./kill-switch.md) — flip `LOOP_KILL_ORDERS` / `_AUTH` / `_WITHDRAWALS` to gate a surface without redeploy                                           |
| **Rollback**          | [rollback.md](./rollback.md) — `fly deploy --image` to a prior release; 90-day rehearsal cadence (A2-1403)                                                           |
| **DR**                | [disaster-recovery.md](./disaster-recovery.md) — region failure / Postgres data loss / operator drain / env compromise; RPO+RTO targets; 180-day rehearsal (A2-1910) |

## Conventions

- **Pages reference live commands.** A runbook that says "check the
  database" without giving the SQL is not finished. Operators run from
  the page; they do not synthesise.
- **Time matters.** Every step gives a rough wall-clock cost so an
  on-call can decide whether to escalate before continuing.
- **Discord channels are linked.** `#ops-alerts`, `#admin-audit`,
  `#deployments` are mentioned by name so a new on-call can find them.
- **No silent fixes.** Mitigation steps that mutate state always pair
  with a Discord post in `#ops-alerts` so the team sees what happened.

A2-1900 covers the existence of this directory and the four starter
runbooks. Future runbooks (rate-limit-blowup, mobile-app-crashes,
admin-double-credit-investigation, etc.) land alongside the alerts that
need them — reference the gap in `docs/audit-2026-tracker.md` if a new
alert lacks a corresponding page.
