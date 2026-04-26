# Runbook · Database migration rollback

## Why this exists

A2-711 flagged that Loop has no documented procedure for rolling
back a Drizzle migration. The pragmatic Phase-1 stance:

- **Drizzle-kit migrations are forward-only by design.** No `down`
  scripts. The cost of maintaining bidirectional migrations exceeds
  the benefit at our deploy cadence.
- **Rollback strategy is forward + Postgres point-in-time restore
  (PITR) where forward fix is too risky.** Most failed migrations
  are recoverable with a follow-up migration that compensates.

This runbook pins the decision tree.

## When to run

A migration failure surfaces in one of three places:

1. **Boot failure on deploy.** `apps/backend/src/index.ts` runs
   `migrate()` before binding ports; a migration error halts
   startup. Fly's deploy gate catches this and rolls back the
   release.
2. **Mid-migration failure.** Postgres rolls each migration into
   its own transaction (drizzle-kit's `breakpoints: true` per
   journal entry). A SQL error inside the transaction reverts the
   migration's individual changes; the journal row is not written;
   next deploy retries.
3. **Successful migration that turns out to be wrong.** This is
   the runbook's primary target — the migration applied cleanly
   but the data shape it produced is incorrect, or the new CHECK
   rejects rows the application generates.

## Severity

- Boot failure on deploy: **P1** (Fly auto-rollback recovers
  service; investigate within the same on-call window)
- Mid-migration failure: **P0 if it leaves the DB in a
  half-committed state** (rare with breakpoints: true), **P1
  otherwise**
- Wrong-after-the-fact: severity matches the user-facing impact
  (could be P0 if writes fail / cashback drift; P3 if cosmetic
  index drift)

## Decision tree

### Boot failure on deploy → use Fly rollback

```bash
fly releases -a loopfinance-api | head -5     # find the prior good release
fly deploy --image registry.fly.io/loopfinance-api:<prior-tag> -a loopfinance-api
```

Fly's release-rollback redeploys the prior image. The Postgres
schema is unchanged (the migration didn't apply); the prior code
runs against the prior schema and is healthy. Investigate the
migration in a follow-up.

Cross-ref: [`rollback.md`](./rollback.md) — the general
release-rollback runbook.

### Mid-migration failure → forward fix on next deploy

Drizzle's `breakpoints: true` per journal entry means each migration
is its own transaction. A failure inside the SQL leaves the DB
exactly as it was before the migration; the journal row is not
inserted. The next `migrate()` retries.

Two failure modes:

- **Idempotency-violating SQL** (e.g. `CREATE INDEX` without `IF
NOT EXISTS` after a partial replay). Add `IF NOT EXISTS` /
  `IF EXISTS` clauses; cut a follow-up migration that supersedes
  the broken one (or amend in place if it has not yet landed in
  prod).
- **Non-deterministic data shape** (e.g. a backfill that picks
  rows differently depending on order). Re-write to be
  deterministic; cut a follow-up migration.

### Successful migration that's wrong → one of three forward paths

Drizzle does not support `down` migrations, so every fix is a
**new migration that compensates**. Three patterns by severity:

#### a. Reversible — drop the bad change, replace with the right one

Schema-only failures (wrong column type, broken index) drop with
the inverse SQL:

```sql
-- migration NNNN_revert_XXXX.sql
DROP INDEX IF EXISTS the_bad_index;
DROP CONSTRAINT IF EXISTS the_bad_check;
ALTER TABLE foo DROP COLUMN bad_col;
```

Then a follow-up migration adds the corrected version. Two
migrations land together in the same deploy.

#### b. Data-touching but non-destructive — compensate forward

The migration added a column with a wrong default that's already
been read by code:

```sql
-- migration NNNN_fix_default.sql
UPDATE foo SET col = correct_value WHERE col = wrong_value;
ALTER TABLE foo ALTER COLUMN col SET DEFAULT correct_value;
```

The compensating UPDATE runs once at deploy. Wrap large UPDATEs
with explicit `WHERE` clauses to avoid full-table scans.

#### c. Destructive — Postgres point-in-time restore (PITR)

If the bad migration **deleted rows or corrupted data** that we
need back:

1. Stop the affected services (`fly secrets set LOOP_KILL_*` per
   `kill-switch.md`) — no further writes.
2. Snapshot the current DB state for forensics (Fly Postgres
   automatic backups every hour; trigger an immediate one with
   `fly postgres backup create`).
3. Restore to a point before the bad migration:
   ```bash
   fly postgres backup list -a loopfinance-pg
   fly postgres restore --backup-id <id-from-before-bad-migration> -a loopfinance-pg
   ```
4. Replay any orders / payments that came in during the lost
   window (cross-ref `disaster-recovery.md` §"Postgres data loss"
   for the post-restore reconciliation pass).

PITR is destructive of any rows written between the restore point
and now — only use it when the alternative (running with corrupt
data) is worse. Rehearsal cadence pinned in
[`disaster-recovery.md`](./disaster-recovery.md) §"180-day
rehearsal" — first drill includes a synthetic bad-migration
restore.

## Resolution

Each path closes with:

1. The compensating migration committed + deployed
2. A Discord post in `#deployments` describing what went wrong +
   what fixed it
3. The migration's tracker / audit ID added to the post-mortem

## Post-mortem

- Always for **boot failure on deploy** that affected production
  uptime — write up cause + the migration-review gap that let it
  through.
- Always for **PITR** — destructive, lost-window data needs an
  audit trail.
- For mid-migration failure or wrong-after-the-fact — only if the
  user-facing impact warrants. A cosmetic-index drift is a
  housekeeping item, not a P0.

## How to make this runbook never trigger

- **Stage every migration on a scratch DB** during PR review.
  `docker compose up -d db` + `npm --workspace=@loop/backend run
migrate` is enough to catch SQL syntax errors and basic shape
  mistakes.
- **CHECK / NOT NULL additions on populated tables**: write the
  migration to ALTER without the CHECK first, populate / clean
  the rows, then add the CHECK in a follow-up. Never combine a
  schema-tightening with the row-clean step.
- **Index additions on large tables**: `CREATE INDEX CONCURRENTLY`
  outside a transaction. Drizzle's `--no-transaction` flag (set
  per-migration) opts out of the implicit txn so concurrent index
  builds work.
- **Follow `docs/development.md` §"Adding a migration"** — pre-flight
  list before drizzle-kit generate.

## Related

- [`rollback.md`](./rollback.md) — release rollback (vs. schema
  rollback documented here)
- [`disaster-recovery.md`](./disaster-recovery.md) — Postgres
  data-loss DR procedure (where PITR rehearsals live)
- ADR 012 — Drizzle ORM choice + migration-strategy discussion
- A2-1409 — migration-vs-app-deploy ordering at pipeline layer
  (pipeline ensures migrations land before the app code that
  needs them)
