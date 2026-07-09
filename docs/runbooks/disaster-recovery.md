# Runbook · Disaster recovery

## Operator checklist (B-4 — DR: PITR + offsite backup) 👤

This runbook's Postgres section was hardened 2026-07-09
(`docs/readiness-backlog-2026-07-03.md` B-4 /
`docs/go-live-plan.md` §T1-BS). The **docs + procedure** half is
done; the following operator actions are what's left before the
"Recommended target posture" below is actually true instead of
aspirational. Nothing here is destructive — do them in order,
whenever there's a maintenance window:

- [ ] **Confirm the live Postgres app name and plan** — `fly postgres list`,
      then `fly status -a <app>`. This runbook assumes an **unmanaged**
      Fly Postgres app (ADR 012: provisioned via `flyctl postgres create`
      / `flyctl postgres attach`, not Fly's newer "Managed Postgres"
      product) — confirm that's still true before following the
      unmanaged-specific commands below.
- [ ] **Set explicit volume snapshot retention** — default is 5 days;
      raise it (`fly volumes update <volume-id> --snapshot-retention 14`,
      1–60 day range) so a slow-to-notice incident doesn't fall off the
      back of the window.
- [ ] **Enable WAL-based PITR** — `fly postgres backup enable -a <app>`
      (provisions a Fly-managed Tigris bucket + continuous WAL
      shipping). This is the single highest-leverage change here: it
      moves Postgres RPO from ~24h to low-single-digit minutes. Still
      inside the Fly account, so it does **not** by itself fix the
      "Fly account compromised" exposure below.
- [ ] **Stand up a genuinely offsite backup** — an object-storage bucket
      in a **different vendor account** than Fly (S3/R2/B2; a Fly
      account compromise must not also compromise this copy), plus a
      scheduled encrypted `pg_dump` job pushing to it. See "Recommended
      target posture" for the concrete shape; this is the `[code]` half
      (a GitHub Actions cron workflow) paired with `[operator]` vendor + credential provisioning. Store the bucket credentials as GitHub
      Actions secrets, **not** Fly secrets — that's the point.
- [ ] **Run one real restore drill** — follow "Restore-drill procedure"
      below end-to-end at least once, time it, and record the actual
      RTO. Until this happens, every RTO number in this doc is an
      estimate, not a measurement.
- [ ] **Sign off on the proposed RPO/RTO targets** — see "RPO + RTO
      targets" below. They're marked PROPOSED until an operator either
      accepts them or tightens/loosens them against what the above
      steps actually deliver.

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
  push access and is mid-deploy. **Includes the vendor-compromise
  case**: if Fly itself (not just a Fly token) is the compromised
  party — account takeover, Fly-side breach — every backup that also
  lives inside Fly (daily volume snapshots, and even the WAL/Tigris
  PITR path above) is compromised too. The offsite `pg_dump` copy is
  the only asset in this runbook that survives that scenario.

This is the runbook for the **rare, large-blast-radius incident**.
For the common-case stuck-state surfaces (one stuck payout, one
broken deploy, one ledger-drift row) use the dedicated runbooks
listed in the README index.

## Scope: what's actually at risk (B-4)

Not everything in Postgres is equally hard to lose. This table is
the "what do we actually lose" reference for triage and for scoping
future backup investment — it's the DR-specific complement to
`docs/invariants.md` (which covers correctness invariants, not
recoverability).

| Data class                                                                                                                           | Sole source of truth?                                                                                                                                                                                                                                                                                                                                      | If Postgres is lost                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`user_credits` + `credit_transactions`** (the off-chain ledger mirror)                                                             | **Partially.** Per ADR 036 / `invariants.md` INV-3, on-chain LOOP is authoritative for **emitted** balance, and `mintedNet ≤ balance_minor` — chain gives a **floor**, not the full liability. Any earned-but-not-yet-emitted cashback, in-flight `pending_payouts`, and un-drained legacy `paymentMethod='credit'` balances exist **only** in this table. | **The crown jewel.** Emitted-token balances are reconstructable per-user from Horizon (every LOOP holder's wallet balance is on-chain, public). Unemitted liability is **not** reconstructable from chain — only from a Postgres backup. This is why B-4 exists: the gap between "chain floor" and "true liability" is exactly the offsite-backup RPO window. |
| **`orders`** (loop-native, ADR 010 principal switch)                                                                                 | **Yes, for loop-native orders.** Loop is merchant of record; CTX only sees a wholesale purchase from the operator account via `ctx_settlements`, not a user-to-order mapping.                                                                                                                                                                              | Which user bought which gift card, and the (possibly encrypted, `LOOP_REDEEM_ENCRYPTION_KEY`) redeem code/PIN, is gone unless backed up. `ctx_settlements` + CTX's own invoice would show _that_ Loop bought N cards wholesale, not _for whom_.                                                                                                               |
| **`orders`** (legacy CTX-proxy)                                                                                                      | No — CTX retains its own order record (user-facing, upstream-issued).                                                                                                                                                                                                                                                                                      | Recoverable via CTX support / the monthly-reconciliation cross-check (`docs/runbooks/monthly-reconciliation.md`), with lag and manual effort.                                                                                                                                                                                                                 |
| **`pending_payouts`**                                                                                                                | Partially — a `submitted` row's Stellar tx is on-chain and Horizon-queryable by operator-account history; the row's _bookkeeping_ (idempotency lineage, kind, retry count) is not.                                                                                                                                                                         | A submitted-but-lost payout can be reconciled by replaying Horizon operations for the operator + issuer accounts and matching memos back to users — slow, manual, and exactly what a restore drill should be rehearsed against instead of improvised live.                                                                                                    |
| **`ctx_settlements`**                                                                                                                | No — CTX's own invoicing is the cross-check (`monthly-reconciliation.md`).                                                                                                                                                                                                                                                                                 | Reconstructable from CTX records; idempotency protection (INV-7) would need re-establishing carefully to avoid a double-pay on replay.                                                                                                                                                                                                                        |
| **`users` / `user_identities`**                                                                                                      | Yes (ADR 013: Loop owns auth; CTX is only a supplier pool for CTX-anchored legacy accounts).                                                                                                                                                                                                                                                               | Gone except for fragments in off-DB stores: 14-day Fly access logs and 30-day Sentry events (both list emails/user ids — see `dsr.md` §"Off-DB data") and whatever's in a Privy-provisioned wallet if the user activated one. Not a real recovery path, just forensic scraps.                                                                                 |
| **`staff_roles`**                                                                                                                    | Yes.                                                                                                                                                                                                                                                                                                                                                       | Re-grantable manually (low row count, high visibility — an admin who can't reach `/admin` notices immediately and asks another admin to re-grant).                                                                                                                                                                                                            |
| **`otps` / `refresh_tokens`**                                                                                                        | Yes, but low-stakes.                                                                                                                                                                                                                                                                                                                                       | Every session drops; every user re-authenticates via a fresh OTP. Annoying, not a money-loss event.                                                                                                                                                                                                                                                           |
| **`merchant_cashback_configs`, `ctx_catalog_snapshots`, merchant catalog cache**                                                     | No — CTX is the source; Loop's copy is a cache with a refresh cadence (`REFRESH_INTERVAL_HOURS`).                                                                                                                                                                                                                                                          | Rebuilds automatically on next sync tick. No backup needed for this class.                                                                                                                                                                                                                                                                                    |
| **Watcher/reconciliation state** (`asset_drift_state`, `watchdog_alert_state`, `watcher_cursors`, `operator_wallet_baselines`, etc.) | Yes, but self-healing by design.                                                                                                                                                                                                                                                                                                                           | Watchers re-baseline from a fresh Horizon + ledger read on next tick; cursors may replay a window (idempotency guards elsewhere, per INV-7/INV-9, prevent double-processing). Expect a burst of "already processed" no-ops, not double-spends.                                                                                                                |

**Bottom line:** the ledger mirror and loop-native `orders` are the
only classes where losing Postgres is a genuine, unrecoverable
money-and-trust event. Everything else either has an external source
of truth (chain, CTX) or self-heals. That's what makes the offsite
backup a P0-adjacent gap rather than routine hygiene — it's the money
ledger specifically, not "the database" generically.

## Severity

**P0 always.** The DR plan is exercised either when one of the above
fires, or in the **180-day rehearsal cadence** below (plus the
quarterly offsite-restore check introduced by B-4).

## RPO + RTO targets (Phase 1)

| Surface                           | RPO (max data-loss window)                                                           | RTO (max time-to-restore)                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Postgres (current)                | **24 h** — Fly's daily volume-snapshot cadence, 5-day retention, single vendor (Fly) | **2 h** — restore-from-snapshot to a fresh cluster, **untested** — see checklist above |
| In-memory caches                  | 0 (rebuild on boot from upstream)                                                    | **5 min** — backend boot + first refresh tick                                          |
| User refresh tokens (server-side) | n/a — bearer-only, client holds the secrets                                          | n/a                                                                                    |
| Stellar operator funding          | n/a — cold-storage refill is a separate flow                                         | **15 min** — cold-storage signing + Horizon submit                                     |
| Static web build                  | 0 (immutable image)                                                                  | **5 min** — `fly deploy --image $PRIOR` from rollback runbook                          |

### Proposed targets (B-4) — PENDING OPERATOR SIGN-OFF

Not yet true — gated on the operator checklist above being executed
and rehearsed. Do not treat these as committed SLOs (`docs/slo.md`)
until an operator has signed off per the checklist.

| Surface                                                             | Proposed RPO                                                                                             | Proposed RTO                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres — Fly-internal incident (volume corruption, bad migration) | **≤ 5 min** once `fly postgres backup enable` PITR is on (WAL-based restore-target-time)                 | **≤ 2 h** — comparable to snapshot restore; needs a timed drill to confirm                                                                                        |
| Postgres — Fly account/vendor compromise                            | **≤ time between offsite `pg_dump` runs** — proposed daily to start, tightened once volume/cost is known | **≤ 4 h** — offsite restore is a cold path (download dump, provision scratch Postgres, `pg_restore`, validate) — slower than snapshot/WAL restore by construction |

Once real numbers exist (post-drill), fold the confirmed values back
into the main table above and delete this section — a "proposed"
table that's been true for months without being promoted is a smell.

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

**Before mutating any state**, if the incident could plausibly still
be in progress (active corruption, a runaway migration, an ongoing
compromise), flip the relevant kill switch first
(`docs/runbooks/kill-switch.md`) — `LOOP_KILL_ORDERS` /
`LOOP_KILL_AUTH` / `LOOP_KILL_EMISSIONS` as appropriate — to stop new
writes from landing while you diagnose and restore. A restore against
a database that's still taking live writes is a restore that's wrong
by the time it finishes.

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
stateless; same `fly status` + region scale on `loopfinance-web`.

### Postgres data loss

**First, confirm the actual app name** (`fly postgres list`) —
older docs in this repo have drifted on this; treat `fly postgres
list` as ground truth, not any hardcoded name below.

#### Path A — snapshot restore (current default posture)

```bash
# List available volume snapshots
fly volumes snapshots list <volume-id> -a loopfinance-db

# Restore into a new volume, then a new Postgres app pointed at it
fly postgres create --snapshot-id <snapshot-id> --image-ref <repo>:<tag>
```

This creates a **separate** cluster. Verify the restored data before
cutting over:

```bash
RESTORE_DB_URL=$(fly postgres connect -a <restored-app> -j | jq -r '.url')
psql "$RESTORE_DB_URL" -c "SELECT MAX(created_at) FROM credit_transactions"
psql "$RESTORE_DB_URL" -c "SELECT COUNT(*) FROM users"
```

#### Path B — WAL-based point-in-time restore (once B-4's PITR step is enabled)

```bash
fly postgres backup list -a loopfinance-db
fly postgres backup restore <restored-app-name> \
  -a loopfinance-db \
  --restore-target-time 2026-07-09T03:00:00Z   # RFC3339, up to the moment before the bad write
```

This is a genuine PITR restore (WAL replay), not a daily-snapshot
approximation — use it whenever the incident's start time is known
and the WAL backup has been enabled long enough to cover it.

#### Path C — offsite `pg_dump` restore (Fly-account-compromise case; requires B-4's offsite step)

```bash
# Pull the latest encrypted dump from the offsite bucket (S3-compatible;
# works for S3/R2/B2 with the appropriate --endpoint-url)
aws s3 cp s3://<offsite-bucket>/loop-pg/<latest>.sql.gz.enc ./dump.enc \
  --endpoint-url <offsite-endpoint>
openssl enc -d -aes-256-cbc -pbkdf2 -in dump.enc -out dump.sql.gz -pass file:/path/to/offsite-key
gunzip dump.sql.gz

# Provision a fresh scratch Postgres (new Fly org/account if the
# compromise is Fly-side) and restore into it
createdb loop_restore
psql loop_restore < dump.sql
```

Use Path C when Path A/B are themselves suspect (the compromise is
inside Fly, not just an app-level incident) — it's the only path
whose credentials and storage don't live in the same blast radius as
everything else in this runbook.

**Whichever path you used**, if the data looks right, swap the live
`DATABASE_URL` to point at the restore. The original cluster (if
still reachable) stays around for forensic / ledger-reconciliation
work.

```bash
fly secrets set DATABASE_URL=$RESTORE_DB_URL -a loopfinance-api
```

**Then run reconciliation immediately** to surface any drift between
the on-chain Stellar state and the restored ledger:

```bash
npm --workspace=@loop/backend run check:ledger
```

If the restore lost ledger rows that have already settled on-chain,
the drift surfaces here and you reconcile via admin adjustment +
operator notes (see `ledger-drift.md`). Per the scope table above,
this is expected to matter most for the **unemitted** liability
window — emitted balances self-correct because chain is still
authoritative for those.

### Stellar operator drained

Out-of-band cold-storage refill is the only path. The operator account
is not on a bot — refills are deliberately manual.

1. Pull the cold-storage signer from 1Password. **From an offline
   laptop.**
2. Construct the refund-from-cold transaction (Stellar lab; sign
   offline; QR-transfer to an online machine for submit).
3. Submit via Horizon. There is **no** `LOOP_STELLAR_OPERATOR_ID` env var —
   derive the operator's public key from the secret signer
   (`LOOP_STELLAR_OPERATOR_SECRET`) on a trusted machine, then watch its
   balance:

   ```bash
   OPERATOR_PUBKEY=$(fly ssh console -a loopfinance-api -C \
     "node -e \"const{Keypair}=require('@stellar/stellar-sdk');console.log(Keypair.fromSecret(process.env.LOOP_STELLAR_OPERATOR_SECRET).publicKey())\"")
   echo "https://horizon.stellar.org/accounts/$OPERATOR_PUBKEY"
   ```

4. Re-enable the payout worker if it was killed via
   `LOOP_KILL_EMISSIONS=true`.

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
5. If the compromise is Fly-account-level rather than a single
   leaked token, treat every Fly-hosted backup (daily volume
   snapshots, the WAL/Tigris PITR path) as **compromised too** — fall
   back to the offsite `pg_dump` copy (Path C above), whose
   credentials live in GitHub Actions secrets, a separate blast
   radius by design.
6. File a P0 security incident note (per `SECURITY.md`).

## Backup posture (B-4)

### Current posture — facts only

Loop runs **unmanaged Fly Postgres** (ADR 012: `flyctl postgres
create` + `flyctl postgres attach`), not Fly's newer fully-managed
"Managed Postgres" (MPG) product — the two have different backup
stories and it's easy to conflate them by name.

- **Automatic:** Fly performs daily storage-based snapshots of the
  Postgres volume. Default retention is **5 days**, configurable 1–60
  days via `fly volumes create/update --snapshot-retention <days>`
  ([Fly volume snapshots docs](https://fly.io/docs/volumes/snapshots/)).
  This repo has never explicitly set a retention value, so the live
  cluster is on the 5-day default unless an operator changed it
  out-of-band.
- **Not offsite.** Per Fly's own docs, unmanaged Postgres "does not
  manage off-site backups, etc." — snapshots live inside the same Fly
  account as everything else
  ([Fly Postgres — what you should know](https://fly.io/docs/postgres/getting-started/what-you-should-know/)).
  A Fly account compromise is total backup loss, not just production
  loss.
- **No PITR by default.** The daily-snapshot tool is not
  point-in-time — restoring lands you at the most recent snapshot,
  losing up to 24h of writes. Fly does ship an **opt-in** WAL-based
  backup path (`fly postgres backup enable`, `fly postgres backup
restore --restore-target-time`) that provisions a Fly-managed
  Tigris bucket and streams WAL continuously
  ([Fly Postgres backup/restore docs](https://fly.io/docs/postgres/managing/backup-and-restore/),
  [`fly postgres backup` CLI reference](https://fly.io/docs/flyctl/postgres-backup/),
  [`fly postgres backup restore` CLI reference](https://fly.io/docs/flyctl/postgres-backup-restore/)).
  As of this writing that opt-in path has **not** been enabled for
  Loop's cluster — see the operator checklist at the top.
- **No restore drill has been run.** The RTO figures in this doc are
  estimates from reading the restore commands, not a measured time.
- Fly's fully-managed "Managed Postgres" product (a different
  provisioning path, `fly mpg ...`) advertises a 10-day recovery
  window with automated encrypted backups as part of the service —
  Loop is not on this product, so it doesn't apply, but it's worth
  knowing the option exists if the unmanaged operational burden ever
  stops being worth it ([Fly Managed Postgres](https://fly.io/mpg/)).

### Recommended target posture

Three independent layers, cheapest/highest-leverage first:

1. **Explicit snapshot retention.** `fly volumes update <volume-id>
--snapshot-retention 14` (or longer) — free, one command, no
   architecture change. `[operator]`.
2. **Enable Fly's WAL-based PITR.** `fly postgres backup enable -a
<app>`. Moves Postgres RPO from ~24h to low-single-digit minutes
   for the common "we broke something, need to rewind 20 minutes"
   case. Still inside Fly's blast radius. `[operator]`.
3. **A genuinely offsite, cross-vendor backup.** This is the part
   that actually closes the B-4 gap ("all backups inside Fly → a
   vendor/account compromise is total data loss"):
   - Provision a bucket at a **different vendor** than Fly (Cloudflare
     R2, Backblaze B2, or AWS S3 are all S3-API-compatible, so the
     same tooling works for any of them). `[operator]`.
   - Store its credentials as **GitHub Actions repository secrets**,
     not Fly secrets — the whole point is that a Fly compromise
     shouldn't also leak the offsite credentials. `[operator]`.
   - Add a scheduled GitHub Actions workflow (same shape as
     `.github/workflows/audit-cron.yml`: `schedule:` cron +
     `workflow_dispatch:`, SHA-pinned actions) that:
     1. Connects with the **`loop_readonly`** DB role
        (`docs/deployment.md` §"Postgres role hygiene") — a dump job
        never needs write access.
     2. Runs `pg_dump --format=custom` (a native Postgres client tool
        already present on `ubuntu-latest` runners — no new npm CLI,
        so ADR 029's repo-managed-CLI concern doesn't apply here).
     3. Encrypts the dump (`openssl enc -aes-256-cbc -pbkdf2`, key
        from a GitHub Actions secret, never co-located with the
        bucket).
     4. Uploads via `aws s3 cp` (S3-compatible, works against R2/B2
        with `--endpoint-url`) with a dated object key.
     5. Sets a bucket lifecycle policy for retention (e.g. 30–90
        days) rather than hand-pruning.
     6. Posts a Discord failure notification on a failed run, same
        pattern as `audit-cron.yml`.
        `[code]` — not built yet; this is the shape the next PR should
        take.
   - Cadence to start: **daily**. Revisit once real dump size/duration
     is known — if it's cheap, hourly is strictly better for RPO.

### Restore-drill procedure

Rehearse this, don't just read it. Two variants:

**Quick drill (quarterly) — verify the offsite copy actually
restores:**

1. Pull the most recent offsite dump (Path C commands above).
2. Restore into a scratch **local** Postgres (`docker compose up -d
db` already gives you one) or a scratch Fly app if you want to
   test the full network path too.
3. Point a throwaway `DATABASE_URL` at it and run:
   ```bash
   DATABASE_URL=<scratch-url> npm run check:migration-parity
   DATABASE_URL=<scratch-url> npm --workspace=@loop/backend run check:ledger
   ```
   `check:migration-parity` confirms the schema the dump restored to
   actually matches what `drizzle-kit` expects (catches a stale or
   truncated dump); `check:ledger` confirms
   `computeLedgerDriftSql()` is clean on the restored data (catches a
   dump taken mid-transaction or during a partial write).
4. Spot-check row counts on the crown-jewel tables from the scope
   table above (`user_credits`, `credit_transactions`, `orders`).
5. Tear down the scratch resources. Log the drill (date, dump age at
   restore time, wall-clock duration, anything that broke) in
   `#deployments`.

**Full drill (every 180 days) — the existing DR rehearsal below,
now including a snapshot-vs-PITR-vs-offsite three-way comparison**
once all three layers are live: restore the same point in time via
each path and confirm they agree.

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

The **quarterly offsite-restore quick drill** (above) is a lighter,
more frequent check layered on top of this — it doesn't replace the
180-day full rehearsal, it catches an offsite-backup regression
(broken cron, expired credentials, silently-corrupt dumps) faster
than waiting for the next full drill would.

Rehearsal logs in `#deployments` (date, drill type, timing, anything
that broke). The next scheduled drill goes on the team calendar
post-merge of this runbook.

## Incident procedure — who does what

Follows `docs/oncall.md`: the on-call **primary** (weekly rotation,
two maintainers) is first responder; **secondary** escalates if
primary doesn't ack a P0 within 5 minutes. A DR-class incident is
always P0 (5 min ack / 30 min mitigate / 4h resolve per
`docs/oncall.md` severity table) — open the incident thread
immediately using the template there.

Decision tree once you're in this runbook:

1. **Is this contained to one write path?** (e.g. one bad migration,
   one bad deploy) → flip the narrowest kill switch
   (`LOOP_KILL_ORDERS_LOOP`, not the combined `LOOP_KILL_ORDERS`) and
   use the targeted runbook (`migration-rollback.md`, `rollback.md`)
   instead of full DR.
2. **Is it a region/network problem, not data?** → "Region failure" §
   above. No kill switch needed — traffic rebalances, data is intact.
3. **Is data actually gone or corrupted?** → flip the broad kill
   switches first (`LOOP_KILL_ORDERS=true LOOP_KILL_AUTH=true` at
   minimum — money-moving surfaces stop before you touch the DB), then
   "Postgres data loss" § above. Pick Path A/B/C by whether you trust
   Fly's own storage for this incident (see "Whole-environment
   compromise" for when you don't).
4. **Is the compromise inside Fly itself**, not just a leaked app
   secret? → "Whole-environment compromise" §, and default to Path C
   (offsite) for any restore — don't trust Fly-hosted backups until
   the compromise is fully scoped.

## Post-mortem

**Always**, for any real DR-class incident. The post-mortem template:

- Trigger and detection time.
- RPO + RTO actuals vs targets (use the "Proposed targets" table
  until the checklist above is complete and the numbers graduate to
  the main table).
- Whether the runbook was correct, incomplete, or wrong. Update it
  in the same PR as the post-mortem.
- Customer impact (count, surface, dollars).
- Follow-up tickets with timelines.

## References

- ADR 012 — Drizzle / Postgres-on-Fly stack (unmanaged Fly Postgres).
- ADR 015 / 016 — Stellar topology + payout-submit worker.
- ADR 036 — on-chain-authoritative token model (why emitted balance
  is chain-recoverable but unemitted liability is not).
- `docs/invariants.md` — INV-3 (unbacked-mint bound) and INV-7/INV-9
  (idempotency, relevant to replaying a lossy restore without
  double-paying).
- `docs/oncall.md` — on-call roster, severity SLAs, incident template.
- `docs/deployment.md` §"Postgres role hygiene" — the `loop_readonly`
  role the offsite dump job should use.
- `docs/adr/029-repo-managed-ci-clis.md` — why the offsite-backup
  workflow should stick to preinstalled/action-based tooling
  (`pg_dump`, `aws` CLI) rather than a fresh npm-hosted CLI.
- `runbooks/rollback.md` — used inside the whole-env-compromise flow.
- `runbooks/kill-switch.md` — stop-the-bleed first step before any
  restore.
- `runbooks/stellar-operator-rotation.md` — used after a confirmed
  signer leak.
- `runbooks/ledger-drift.md` — the post-restore reconciliation step
  links here.
- `runbooks/migration-rollback.md` — the narrower schema-rollback
  decision tree; PITR rehearsal details live here.
- Fly docs: [volume snapshots](https://fly.io/docs/volumes/snapshots/),
  [Postgres backup & restore](https://fly.io/docs/postgres/managing/backup-and-restore/),
  ["This is not Managed Postgres"](https://fly.io/docs/postgres/getting-started/what-you-should-know/),
  [`fly postgres backup` CLI](https://fly.io/docs/flyctl/postgres-backup/),
  [`fly postgres backup restore` CLI](https://fly.io/docs/flyctl/postgres-backup-restore/),
  [Fly Managed Postgres](https://fly.io/mpg/).
