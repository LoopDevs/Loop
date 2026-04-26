# Runbook · Disaster recovery

## Symptom

A class-of-incident that takes the whole production surface down or
loses meaningful customer state. Triggers:

- **Region failure** — Fly's `iad` (or `lhr`) datacenter is
  unreachable from end users, and the multi-region routing isn't
  filling the gap.
- **Postgres data loss** — accidental drop, corruption, ransomware,
  cluster failure that exhausts replicas.
- **Stellar operator account drained** — `op_underfunded` across
  every payout indefinitely, and the operator isn't refillable
  because the cold-storage path is broken.
- **Whole-environment compromise** — Fly tokens leaked, attacker has
  push access and is mid-deploy.

This is the runbook for the **rare, large-blast-radius incident**.
For the common-case stuck-state surfaces (one stuck payout, one
broken deploy, one ledger-drift row) use the dedicated runbooks
listed in the README index.

## Severity

**P0 always.** The DR plan is exercised either when one of the above
fires, or in the **180-day rehearsal cadence** below.

## RPO + RTO targets (Phase 1)

| Surface                           | RPO (max data-loss window)                   | RTO (max time-to-restore)                                     |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Postgres                          | **24 h** — Fly's daily snapshot cadence      | **2 h** — restore-from-snapshot to a fresh cluster            |
| In-memory caches                  | 0 (rebuild on boot from upstream)            | **5 min** — backend boot + first refresh tick                 |
| User refresh tokens (server-side) | n/a — bearer-only, client holds the secrets  | n/a                                                           |
| Stellar operator funding          | n/a — cold-storage refill is a separate flow | **15 min** — cold-storage signing + Horizon submit            |
| Static web build                  | 0 (immutable image)                          | **5 min** — `fly deploy --image $PRIOR` from rollback runbook |

Phase-2 targets tighten when point-in-time-recovery (PITR) replaces
daily snapshots and the second region is genuinely active-active
(today it's hot-standby — same image, no shared state).

## Diagnosis

DR triage starts wide, narrows fast. In order:

1. **Is the API reachable at all?** `curl -i https://api.loopfinance.io/health`.
   No response → region or DNS failure (jump to "Region failure" §).
   401/403/5xx → app-level breakage (use the targeted runbook —
   ledger-drift, ctx-circuit-open, kill-switch — instead of DR).
2. **Is Postgres readable?** `psql "$DATABASE_URL" -c "SELECT 1"`.
   Error → DB failure (jump to "Postgres data loss" §).
3. **Is the operator account funded?** `fly logs -a loopfinance-api | grep op_underfunded` for repeated hits, then check the Horizon
   balance directly. Empty operator → "Stellar operator drained" §.
4. **Is someone else deploying?** `fly releases list -a loopfinance-api` — an unexpected recent release with an unknown
   committer is the compromise signal (jump to "Whole-env compromise" §).

## Mitigation

### Region failure

Fly's anycast routes users to the nearest region; if `iad` is down,
`lhr` should pick up. If both are down (or one + the other is at
capacity), the rolling window is short — Fly's regional failure
recoveries usually land in <30 min.

```bash
# Check region health
fly status -a loopfinance-api
# Manual region scale if one is degraded
fly scale count 2 --region lhr -a loopfinance-api
fly scale count 0 --region iad -a loopfinance-api
```

Once `iad` recovers, scale back symmetrically. The web app is
stateless; same `fly status` + region scale on `loop-web`.

### Postgres data loss

Fly's managed Postgres takes a daily snapshot. To restore:

```bash
# List available snapshots
fly postgres backups list -a loopfinance-db

# Pick the most recent pre-incident snapshot id
fly postgres backups restore <snapshot-id> --target-app loopfinance-db-restore
```

This creates a **separate** cluster (`loopfinance-db-restore`).
Verify the restored data:

```bash
RESTORE_DB_URL=$(fly postgres connect -a loopfinance-db-restore -j | jq -r '.url')
psql "$RESTORE_DB_URL" -c "SELECT MAX(created_at) FROM credit_transactions"
psql "$RESTORE_DB_URL" -c "SELECT COUNT(*) FROM users"
```

If the data looks right, swap the live `DATABASE_URL` to point at
the restore. The original cluster stays around for forensic /
ledger-reconciliation work.

```bash
fly secrets set DATABASE_URL=$RESTORE_DB_URL -a loopfinance-api
```

**Then run reconciliation immediately** to surface any drift between
the on-chain Stellar state and the restored ledger:

```bash
npm --workspace=@loop/backend run check:ledger
```

If the snapshot lost ledger rows that have already settled on-chain,
the drift surfaces here and you reconcile via admin adjustment +
operator notes (see `ledger-drift.md`).

### Stellar operator drained

Out-of-band cold-storage refill is the only path. The operator account
is not on a bot — refills are deliberately manual.

1. Pull the cold-storage signer from 1Password. **From an offline
   laptop.**
2. Construct the refund-from-cold transaction (Stellar lab; sign
   offline; QR-transfer to an online machine for submit).
3. Submit via Horizon. Watch the operator balance via
   `https://horizon.stellar.org/accounts/$LOOP_STELLAR_OPERATOR_ID`.
4. Re-enable the payout worker if it was killed via
   `LOOP_KILL_WITHDRAWALS=true`.

### Whole-environment compromise

If Fly tokens are confirmed leaked:

1. **Rotate Fly tokens immediately.** Fly dashboard → Personal Access
   Tokens → revoke all → mint new for the operator.
2. **Force-deploy a known-good image** (rollback runbook).
3. **Rotate every Fly secret** that the leaked token could read:
   `LOOP_JWT_SIGNING_KEY`, `LOOP_STELLAR_OPERATOR_SECRET`,
   `GIFT_CARD_API_KEY/SECRET`, `DATABASE_URL` credentials, Discord
   webhooks.
4. **Audit the `fly logs`** for unauthorised actions during the
   compromise window. Fly's free-tier audit log is short — pull
   immediately, archive externally.
5. File a P0 security incident note (per `SECURITY.md`).

## 180-day rehearsal cadence (A2-1910)

The DR plan is rehearsed **every 6 months**:

- **Postgres restore drill** — restore the latest snapshot to a
  scratch cluster, run reconciliation, time the end-to-end. Target:
  RTO inside 2 hours.
- **Region-fail drill** — manually scale `iad` to 0 + observe traffic
  rebalance to `lhr`. Target: 5-minute traffic recovery.
- **Operator-refill drill** — practice the cold-storage signing flow
  on a low-stakes signer + non-prod operator. Target: 15-minute
  refill from start to first confirmed payout.

Rehearsal logs in `#deployments` (date, drill type, timing, anything
that broke). The next scheduled drill goes on the team calendar
post-merge of this runbook.

## Post-mortem

**Always**, for any real DR-class incident. The post-mortem template:

- Trigger and detection time.
- RPO + RTO actuals vs targets.
- Whether the runbook was correct, incomplete, or wrong. Update it
  in the same PR as the post-mortem.
- Customer impact (count, surface, dollars).
- Follow-up tickets with timelines.

## References

- ADR 012 — Drizzle / Postgres-on-Fly stack.
- ADR 015 / 016 — Stellar topology + payout-submit worker.
- `runbooks/rollback.md` — used inside the whole-env-compromise flow.
- `runbooks/stellar-operator-rotation.md` — used after a confirmed
  signer leak.
- `runbooks/ledger-drift.md` — the post-restore reconciliation step
  links here.
