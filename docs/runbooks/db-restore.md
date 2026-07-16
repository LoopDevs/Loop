# DB backup & restore runbook (NS-07)

The production database is **Fly Managed Postgres** — cluster `loopfinance-postgres`
(id `k1v53olx88eo8q6p`, PG 16 Percona, region `iad`, attached to `loopfinance-api`).

## Backups (validated)

MPG takes **automated backups** — hourly incrementals plus periodic differential/full —
with no operator action. Confirmed live: a continuous backup chain across every hour.

- **List backups:** `fly mpg backup list k1v53olx88eo8q6p`
- **On-demand full backup:** `fly mpg backup create k1v53olx88eo8q6p`
  (returns a `backup_<ts>_<id>` — validated working.)

Take an on-demand backup before any destructive maintenance (schema change that could
fail, data backfill, DB move).

## Restore — DRILL PENDING, do NOT run blind on the live cluster

`fly mpg restore <CLUSTER_ID> --backup-id <BACKUP_ID>` restores a cluster from a backup.
**Its new-cluster-vs-in-place semantics are not documented** (Fly's `/docs/mpg/…` pages
404 as of 2026-07-16). Running it in-place against `k1v53olx88eo8q6p` could roll the live
cluster back or take it offline — so it is **not** run autonomously.

### Recommended drill (ideal to do while pre-traffic — data is trivial and reproducible)

Do this as a deliberate exercise, with an operator watching:

1. `fly mpg backup create k1v53olx88eo8q6p` — a fresh known-good checkpoint first.
2. `fly mpg backup list k1v53olx88eo8q6p` — note the latest completed backup id.
3. **Confirm restore behaviour before touching prod**: either verify with Fly support /
   current docs that `fly mpg restore` provisions a NEW cluster (non-destructive), or run
   the restore in a scheduled maintenance window accepting brief downtime + a possible
   roll-back of the live cluster to the backup point.
4. `fly mpg restore k1v53olx88eo8q6p --backup-id <id>` — run it.
5. Verify: schema is current (migrations through the latest, e.g. `0074`), row counts
   sane, `GET https://api.loopfinance.io/health` → 200, app functional.
6. If a new cluster was produced, re-point / detach the scratch cluster and clean up.

**Success = the restore produced a usable, current-schema, healthy database.** Record the
outcome (backup id, elapsed time, any manual steps) here after the first successful drill.

## Residual (NS-07 tail)

- **Tested restore**: the drill above — not yet executed (pending the semantics
  confirmation or a maintenance window).
- **Offsite copy**: MPG backups live in Fly's storage. An independent offsite copy
  (e.g. a periodic `pg_dump` shipped to object storage) is a further hardening step;
  note the app container is Node-only (no `pg_dump`), so this would run from a
  separately-provisioned job, not the API machine.
