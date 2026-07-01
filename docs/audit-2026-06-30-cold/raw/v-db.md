# Vertical DB/schema/migrations — raw findings (cold audit 2026-06-30)

Scope: `apps/backend/src/db/{client.ts,schema.ts,users.ts}`, all 38 migrations
`0000`→`0037`, `meta/_journal.json` + `meta/0000_snapshot.json`,
`drizzle.config.ts`, `apps/backend/src/scripts/check-migration-parity.ts` +
`scripts/migration-parity-allowlist.json`, `apps/backend/src/db/__tests__/*`.
Cross-read into consuming code wherever a schema/migration claim needed
verifying against real call sites (orders/payments/credits handlers,
`@loop/shared`, `fly.toml`, `env.ts`, `index.ts`, deployment docs).

Files examined: 38/38 migrations + 9 supporting DB-layer files + 5 test files
(full list in Coverage confirmation below).

Method note: this audit independently re-derived every finding from current
code before opening the 06-15 raw doc. Two 06-15 findings (P1-01 withdrawal
docstring, P2-03 no-down-migration-story) turned out to be stale/inaccurate
even at the time they were filed — see Delta re-verification / Coverage
confirmation for the evidence. One new finding was empirically verified by
spinning up a disposable Postgres 16 container and reproducing the exact
GRANT/REVOKE sequence the migration runs.

## Findings

### DB-01 [P1 · LIVE] Migration 0035's column-level REVOKE on `loop_readonly` is a no-op against the documented production grant pattern — the CF-25 "second layer" does not function

- File: `apps/backend/src/db/migrations/0035_orders_redeem_revoke_readonly.sql:31-37`; `docs/deployment.md:141-144`
- Description: Migration 0035 runs `REVOKE SELECT (redeem_code, redeem_pin) ON orders FROM loop_readonly` (guarded by a role-existence check) and the commit/comment frames this as a second defence layer on top of the CF-25 application-layer encryption: "an analytics/dashboard credential can't even pull the ciphertext." `docs/deployment.md:141` documents the role's intended shape as **`SELECT` only on every table in the schema** — i.e. the standard provisioning pattern is a blanket `GRANT SELECT ON ALL TABLES IN SCHEMA public TO loop_readonly` (or per-table `GRANT SELECT ON orders TO loop_readonly`), not a column-scoped grant. PostgreSQL's privilege model does **not** let a column-level `REVOKE` override a table-level `GRANT`: if the role's SELECT came from the table-level grant, the column ACL (`pg_attribute.attacl`) was never populated, so the column-level `REVOKE` finds nothing to remove and silently succeeds while changing nothing.
- Impact: In the documented/standard provisioning shape, `loop_readonly` retains full `SELECT` on `redeem_code` / `redeem_pin` after migration 0035 "succeeds." Gift-card redeem codes/PINs are spendable bearer instruments — literally money. Two compounding factors raise this from theoretical to live-risk:
  1. `LOOP_REDEEM_ENCRYPTION_KEY` is documented as **"Recommended (prod)"**, not required (`docs/deployment.md:107`), and the code explicitly "ships dark" (boot only warns, never fails, when unset — `index.ts:54-61`). In any environment/window where the key is unset, the column holds **plaintext**, and the broken revoke means `loop_readonly` can read it directly.
  2. Even once the key is set, old rows written before the key existed remain plaintext forever (no backfill, by design — `redeem-crypto.ts:30-36`), so the exposure window doesn't fully close retroactively.
  3. `docs/deployment.md:155-159` states outright: "The repo can't introspect the live DB roles… Drift surfaces if a migration starts failing" — i.e. there is no mechanism, in-repo or in CI, that would ever notice this is broken. `check-migration-parity.ts`'s introspection explicitly excludes grants/ACLs (its own comment: "the migration↔schema.ts parity check inspects columns / constraints / triggers, not grants"). No test anywhere (`grep -rln loop_readonly` across `*.ts`) ever creates the role and asserts restricted access — the only three repo references to `loop_readonly` are a doc, the schema comment, and the migration itself.
- Evidence: reproduced live against Postgres 16 (disposable container, not the project's DB):
  ```
  CREATE TABLE orders (id int primary key, redeem_code text, redeem_pin text, redeem_url text);
  CREATE ROLE loop_readonly LOGIN PASSWORD 'test';
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO loop_readonly;   -- the documented pattern
  REVOKE SELECT (redeem_code, redeem_pin) ON orders FROM loop_readonly;  -- migration 0035's statement
  -- as loop_readonly:
  SELECT * FROM orders;
  --  id | redeem_code | redeem_pin |     redeem_url
  --   1 | CODE123     | PIN456     | http://example.com      <-- STILL VISIBLE
  ```
  For comparison, the pattern that actually works (table-level REVOKE + column-allowlist GRANT) was verified in the same session to correctly deny `SELECT redeem_code FROM orders` with `ERROR: permission denied for table orders` while still allowing `SELECT id, redeem_url`.
- Minimal fix: Change migration 0035 (as a new migration, since 0035 already shipped) to `REVOKE SELECT ON orders FROM loop_readonly;` followed by `GRANT SELECT (<every column except redeem_code, redeem_pin>) ON orders TO loop_readonly;` — i.e. flip from "deny two columns" to "allow everything else," which is the pattern Postgres actually enforces. This is fragile (must be kept in sync with every future `orders` column) but closes the hole with one migration.
- Better fix: (1) Don't manage this via ad-hoc REVOKE/GRANT SQL reasoning about an unknown live ACL state at all — have ops re-provision `loop_readonly` from a single idempotent script that the repo owns (e.g. `scripts/provision-readonly-role.sql`, run via a documented runbook step, never "whatever was typed into psql once"), with the secret columns excluded from the initial grant. (2) Add real CI coverage: in `check-migration-parity.ts` (or a sibling script run in the `flywheel-integration` job), create a `loop_readonly` role against the scratch DB, replay the migration chain, and assert via `information_schema.column_privileges` (or an actual `SET ROLE loop_readonly; SELECT redeem_code …` expected-to-fail probe) that the two columns are genuinely unreadable. This turns the claimed "second layer" into an empirically-verified one instead of a comment. (3) Update `docs/deployment.md`'s `loop_readonly` bullet to state the exact grant statement ops must run, not the current generic "SELECT only on every table in the schema" — the current wording is itself what leads to the standard (broken-for-this-purpose) provisioning pattern.
- Ref: CF-25 / X-PRIV-03; ADR 015 (redeem secrets); checklist §16 "encryption at rest", §2 "secrets never logged" (adjacent), Part 6 framing on defence-in-depth controls that don't actually defend.

### DB-02 [P2 · LIVE, carried forward] Boot-time migrator still shares the request pool's 30s `statement_timeout` — unaddressed since 06-15

- File: `apps/backend/src/db/client.ts:51-87`; `apps/backend/src/env.ts:198-209`; `apps/backend/fly.toml:8-14`
- Description: `runMigrations()` calls `migrate(db, …)` against the same `drizzle(client)` whose connections carry `statement_timeout=DATABASE_STATEMENT_TIMEOUT_MS` (default 30000ms) as a startup parameter. This is unchanged since the 06-15 audit (`client.ts` is not in the 06-15→06-30 delta file list). `fly.toml`'s `[deploy] release_command = "node apps/backend/dist/migrate-cli.js"` now runs migrations once, in a single one-shot release machine, before any app machine takes traffic — this is a real improvement over relying solely on the boot-time path (it removes the _concurrent-migration_ risk, see DB-03), but it does **not** address the timeout risk: `migrate-cli.js` presumably reuses the same `db/client.ts` connection helper, so the release-machine connection still carries the same 30s cap. The chain already contains a full-table backfill (`0007`: `UPDATE orders SET … WHERE charge_minor = 0`) and `orders` / `credit_transactions` / `pending_payouts` are exactly the tables expected to grow fastest in production.
- Impact: Latent — not triggered at current volume (every migration today completes well under 30s). A future data-migration on a large table self-aborts mid-deploy; because each migration's statements run in one transaction, a timeout rolls back cleanly (no half-applied state) but the release machine exits non-zero and the deploy is blocked until the migration is rewritten to fit the budget, fitting Fly's batched/short-DDL pattern only.
- Evidence: `env.ts:200-209` comment self-admits the tradeoff ("the migrator path runs through the same pool and can take longer on a fresh-clone replay; default keeps boot-time migrations well-bounded since none currently exceed 5s of pure DDL").
- Minimal fix: Set `DATABASE_STATEMENT_TIMEOUT_MS=0` in the `release_command` machine's environment specifically (Fly supports per-process env overrides, or `migrate-cli.js` can call `process.env['DATABASE_STATEMENT_TIMEOUT_MS'] = '0'` before importing `client.ts`).
- Better fix: Give the migrator its own short-lived `postgres()` client with `statement_timeout=0` (or a generous fixed bound like 10 minutes), entirely separate from the request-serving pool, so the two concerns (protect request-handling connections from runaway queries vs. let a legitimate long migration finish) are never coupled to one knob again.
- Ref: A2-724; checklist §9 "data migrations safe (batched, no lock storms)"; 06-15 raw P2-01 (re-confirmed still open).

### DB-03 [P3 · LIVE, new] `drizzle-orm`'s migrator has no DB-level mutual exclusion across concurrent invocations; mitigated operationally but not structurally

- File: `node_modules/drizzle-orm/pg-core/dialect.js:44-69` (library code, traced for this audit); `apps/backend/src/index.ts:72`; `apps/backend/fly.toml:8-14`
- Description: Traced `PgDialect.migrate()`: it reads the last-applied migration row with a plain `SELECT … ORDER BY created_at DESC LIMIT 1` (no lock), then applies all newer migrations inside a single transaction. There is no `pg_advisory_lock` / `SELECT … FOR UPDATE` anywhere in the migrator. If two processes call `migrate()` concurrently while a migration is pending, both can pass the "is this newer?" check and begin applying the same migration in parallel transactions — for migrations using bare `CREATE TABLE` / `CREATE INDEX` (the project's own early migrations, 0000-0026ish, predate the `IF NOT EXISTS` convention adopted from 0026+ — see DB-05) this errors out (`relation already exists`) rather than serializing gracefully, and even for `IF NOT EXISTS`/idempotent migrations, both transactions can independently insert a row into `__drizzle_migrations` (no uniqueness constraint on `hash` in that table), leaving a harmless but confusing duplicate journal row.
  `fly.toml`'s `release_command` is exactly the structural mitigation this needs: Fly runs the release command in a single one-off machine and blocks new app machines from starting until it exits 0, so in the documented deploy path migrations apply exactly once before any concurrent app instance exists, and the boot-time `runMigrations()` call in `index.ts:72` becomes a true no-op (last-migration check finds nothing pending). This mirrors the exact root cause CF-14 fixed for the payout worker ("every Loop background worker runs in-process on every Fly machine — no leader election") — the same root cause applies to the migrator, but unlike the payout worker, the migrator was never revisited with a row/advisory lock, because the release_command pattern sidesteps it at the infra layer instead.
- Impact: Low under the documented Fly deploy path. The residual risk: (a) local dev / CI running two `npm run dev:backend` instances or two test workers against the same scratch DB simultaneously could hit this; (b) any future change to the deploy strategy (bluegreen, manual `flyctl scale count N` mid-deploy, a non-Fly target) that bypasses `release_command` re-exposes the exact race with no DB-level backstop.
- Minimal fix: None required given the current `release_command` mitigation; document the dependency explicitly (a comment in `client.ts` or `index.ts` noting that `runMigrations()`'s safety against concurrent execution is an _infra_ guarantee, not a DB-level one).
- Better fix: Wrap `runMigrations()` in a `pg_advisory_lock` (or `pg_try_advisory_lock` with a short retry) keyed on a fixed constant, so the migrator is self-protecting regardless of deploy topology — the same posture CF-14 chose for the payout worker, applied one layer earlier in the boot sequence.
- Ref: CF-14 (X-2 concurrency-financial, payout-worker `FOR UPDATE SKIP LOCKED`); checklist Part 6 §33 ("are there other in-process workers/schedulers that still assume single-instance execution").

### DB-04 [P3 · LIVE, new] `client.ts`'s `closeDb()` docstring is stale — it IS wired into process shutdown

- File: `apps/backend/src/db/client.ts:89-93`; `apps/backend/src/index.ts:217-247`
- Description: The docstring on `closeDb()` reads: "Best-effort graceful shutdown hook. **Not wired into the process by default** — call from a SIGTERM handler if the deploy target needs the pool flushed." This is inaccurate: `index.ts`'s `shutdown()` function (registered for both `SIGTERM` and `SIGINT`) calls `Promise.allSettled([sentryFlush(5000), closeDb()])` inside `server.close()`'s callback. The function is wired in, contradicting its own comment.
- Impact: Pure doc-integrity drift (checklist §5) — no functional bug; a future maintainer reading the comment in isolation could believe shutdown handling needs to be added when it already exists, or could miss that `closeDb()` has a live caller when refactoring.
- Minimal fix: Update the comment to reflect `index.ts`'s actual wiring, e.g. "Called from `index.ts`'s SIGTERM/SIGINT shutdown handler after the HTTP server drains."
- Better fix: Same as minimal — this is a one-line doc fix, no design change warranted.

### DB-05 [P3 · LIVE, carried forward] Inconsistent `IF NOT EXISTS` discipline across the migration chain

- File: `0000/0001/0002/0003/0004/0005/0006/0007/0008/0009/0010/0011/.../0025` (bare `CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`) vs. `0019/0026/0027/0029/0030/0031/0032/0033/0034` (adopt `IF NOT EXISTS` / `DROP … IF EXISTS` for partial-apply safety)
- Description: Confirmed unchanged since 06-15. The later convention is strictly safer for the mid-migration-failure recovery path documented in `docs/runbooks/migration-rollback.md` ("Mid-migration failure → forward fix on next deploy… Idempotency-violating SQL… Add IF NOT EXISTS / IF EXISTS clauses"). Earlier migrations don't carry that safety net, though in practice they're long-applied to every environment and won't replay from scratch except on a brand-new DB (where they apply cleanly in order once).
- Impact: Minor — only matters during a partial-apply recovery on an old migration, which is rare (those migrations are deeply in the past for every live environment).
- Minimal fix: None required retroactively; document the `IF NOT EXISTS` convention as mandatory going forward in the migration-authoring recipe (it already is, implicitly, by example — make it explicit).
- Better fix: No action needed pre-launch.

### DB-06 [P3 · LIVE, carried forward] No SSL/TLS enforcement on `DATABASE_URL`

- File: `apps/backend/src/db/client.ts:57-73`; `apps/backend/src/env.ts:192-197`
- Description: Confirmed unchanged since 06-15. `postgres(env.DATABASE_URL, {…})` passes no `ssl` option; encryption in transit depends entirely on `sslmode=require` being present in the connection string, with no boot-time check.
- Impact: Low in the current Fly topology (private WireGuard mesh), but the protection is environmental, not enforced — relevant given the data in transit includes ledger balances, redeem codes/PINs, OTP hashes, refresh-token hashes.
- Minimal fix: In `NODE_ENV=production`, validate `DATABASE_URL` contains `sslmode=require` (or an equivalent) at boot, failing closed if not and the host isn't a recognized private Fly address.
- Better fix: Pass an explicit `ssl` option to the `postgres()` client keyed off environment (`'require'` outside known-private hosts), and document the Fly-internal carve-out.
- Ref: checklist §16 "encryption in transit"; 06-15 raw P3-03 (re-confirmed still open).

## Delta re-verification

### CF-14 — `FOR UPDATE SKIP LOCKED` row-claim for the payout worker

- What changed: `credits/pending-payouts.ts:listClaimablePayouts()` added `.for('update', { skipLocked: true })` to the candidate-row query, closing the cross-machine double-pick race (no leader election across Fly machines).
- Schema support: No new column needed (the query already had a stable PK). Index support already adequate: `pending_payouts_state_created (state, created_at)` (migration 0010/unchanged) serves both branches of the `state='pending' OR (state='submitted' AND submitted_at < cutoff AND attempts < cap)` predicate — Postgres can use the leading `state` column to narrow each branch before the row-lock scan. No missing index found.
- Verdict: **fully closed.** No schema gap.

### CF-18 — authoritative tx-hash payout idempotency

- What changed: `pending_payouts.tx_hash` (column already existed since migration 0010) is now stamped via `recordPayoutTxHash()` immediately after signing, before submit; the worker's re-pick path checks Horizon's `GET /transactions/{hash}` directly (an external point lookup, not a DB query) instead of relying solely on the bounded memo-scan window.
- Schema support: Correctly required **no migration** — `recordPayoutTxHash` is a PK (`id`)-scoped `UPDATE … WHERE id = ? AND state = 'submitted'`, and the authoritative re-pick check never queries the DB by `tx_hash`, so no index on that column is structurally needed. Verified no migration was added in the 0035-0037 delta for this.
- Optional defence-in-depth (not required, not filed as a finding): a partial unique index `ON pending_payouts (tx_hash) WHERE tx_hash IS NOT NULL` would catch a hypothetical future bug that stamps the same hash onto two distinct payout rows, at zero cost given Stellar tx hashes are derived from per-row-unique envelope content (sequence number, source, memo). Current behaviour is already correct without it.
- Verdict: **fully closed.**

### CF-19 — extended-market order path / `orders_currency_known` CHECK

- What changed: Migration 0037 widens the `orders_currency_known` CHECK from `('USD','GBP','EUR')` to `('USD','GBP','EUR','AED','INR','SAR','AUD','MXN')`. `orders.charge_currency`, `users.home_currency`, `user_credits.currency`, `credit_transactions.currency` deliberately remain unwidened (extended markets have no LOOP asset / cashback band).
- Verification: Cross-checked `packages/shared/src/loop-asset.ts`'s `ORDERABLE_CURRENCIES = [...HOME_CURRENCIES, ...EXTENDED_ORDER_CURRENCIES]` (= `USD,GBP,EUR,AED,INR,SAR,AUD,MXN`) — exact match with migration 0037's CHECK list. The order handler (`orders/loop-handler.ts:259-317`) validates against `isOrderableCurrency`, FX-pins the charge to the user's home currency, and returns a clean `CURRENCY_NOT_AVAILABLE` 503 (not a DB CHECK violation surfaced as 500) when the rates feed doesn't yet serve an extended currency. A dedicated test, `db/__tests__/orders-currency-check.test.ts`, parses both the migration SQL and the `schema.ts` mirror and asserts both equal `ORDERABLE_CURRENCIES` — drift in any of the three sources fails in unit tests.
- Verdict: **fully and correctly closed**, with above-bar regression protection (the 06-15 audit's P3-04 — "schema is the only structural fence, no migration yet" — is now moot; the migration landed and the handler-level fence was also verified, not just assumed).

### CF-25 — redeem-code encryption columns + `loop_readonly` revoke

- What changed: `orders/redeem-crypto.ts` (new) wraps `redeem_code`/`redeem_pin` in an AES-256-GCM envelope (`enc:v1:…`) at the application layer, backward-compatible with legacy plaintext rows and key-unset writes. Migration 0035 additionally revokes `loop_readonly`'s column-level SELECT on the two secret columns as a "second layer."
- Verification: The encryption layer itself is well-built — versioned envelope prefix, fail-closed on tamper (`RedeemDecryptError` on GCM auth-tag mismatch), idempotent re-encrypt guard, boot-time key-length validation, single boot warn when unset. Persistence path (`orders/fulfillment.ts`, `orders/redemption-backfill.ts`) consistently routes through `encryptRedeemField`; read path (`orders/loop-read-handlers.ts`) consistently routes through `decryptRedeemField`. The redemption-backfill partial index's `IS NULL` predicate (migration 0034) remains correct post-encryption because `encryptRedeemField(null) === null` (ciphertext only ever replaces a non-null plaintext).
  The role-level revoke is **empirically broken** against the documented production grant pattern — see **DB-01** above for the full reproduction. In short: a column-level `REVOKE` cannot override a table-level `GRANT`, and `docs/deployment.md` documents `loop_readonly` as having table-level (not column-scoped) SELECT.
- Verdict: **partially closed.** The primary control (application-layer encryption) is correctly implemented and is the dominant protection once `LOOP_REDEEM_ENCRYPTION_KEY` is set. The explicitly-claimed secondary control (DB role-level revoke) does not function as designed in the documented role-provisioning model and has zero test coverage to ever catch the gap. See DB-01 for fix.

### CF-29 — hot-path indexes + TTL cache for public stats

- What changed: Migration 0036 adds 7 indexes (`orders_created_at`, `credit_transactions_type_created`, `orders_ctx_operator_created`, `pending_payouts_asset_state`, `pending_payouts_confirmed_at`, `orders_loop_asset_created`, `orders_paid_procuring_created`, `users_email_lower`, `user_credits_currency` — 9 total) plus a process-memory TTL cache in `public/cashback-stats.ts`.
- Verification: Every index in migration 0036 has an exact-name match in `schema.ts` (grep-verified line-by-line — `orders_created_at:559`, `credit_transactions_type_created:204`, `orders_ctx_operator_created:565`, `orders_loop_asset_created:570`, `orders_paid_procuring_created:577`, `pending_payouts_asset_state:882`, `pending_payouts_confirmed_at:887`, `users_email_lower:92`, `user_credits_currency:143`) — no migration↔schema drift. Spot-checked three consumers: `public/cashback-stats.ts` (the `type='cashback'` aggregates are served by `credit_transactions_type_created`; the `state='fulfilled'` count is served by the pre-existing `orders_fulfilled_at` partial), `admin/settlement-lag.ts` (the `state='confirmed' AND confirmed_at >= since` filter is served by the new partial `pending_payouts_confirmed_at`), `admin/payouts-by-asset.ts` (the `GROUP BY asset_code, state` is served by the new composite `pending_payouts_asset_state`). The TTL cache correctly doubles as both a compute-storm guard and a last-known-good fallback (ADR 020 never-500), with test-only reset hooks (`__resetPublicCashbackStatsCache`, `__expirePublicCashbackStatsCache`).
- Verdict: **fully closed.** No missing index found on the hot paths touched by this delta.

### Reassessment of two 06-15 findings that turned out to be stale (not part of my delta scope but flagged by the brief as items to re-check)

- **06-15 P1-01** ("duplicate-withdrawal at-most-once leans entirely on `pending_payouts_active_withdrawal_unique`; schema docstring doesn't carry the caveat"): the docstring at `schema.ts:212-228` already states "The admin withdrawal path also has a stronger semantic fence on `pending_payouts` for 'same active withdrawal intent' races" — `git blame` shows this text present since commit `e7eb665c` (2026-05-03), which **predates** the 06-15 audit baseline (`04c3fae0`, 2026-06-15). The claimed-missing caveat was already in the file when the 06-15 audit ran. Separately, tracing `credits/withdrawals.ts`: the `SELECT … FOR UPDATE` lock on `user_credits (userId, currency)` is acquired _before_ the duplicate-withdrawal pre-check and the `pending_payouts` insert, so concurrent withdrawal attempts for the same user+currency are serialized through that lock — the partial unique index (`pending_payouts_active_withdrawal_unique`) is then a true backstop, not the sole defence. This finding is **not re-raised**; it appears to have been inaccurate even when filed.
- **06-15 P2-03** ("no reversibility / down-migration story"): `docs/runbooks/migration-rollback.md` (present since 2026-04-26, also predating the 06-15 baseline) documents a deliberate, detailed forward-only-migration + PITR policy with a decision tree, severity table, and a "how to make this runbook never trigger" section. The policy is real and reasoned, not absent. **Downgraded to informational** — not re-raised as an open finding in this audit; the prior framing ("no... story") undersold the existing runbook.
- **06-15 P2-02** ("stale `0000_snapshot.json`"): confirmed structurally still true (only the 0000 baseline snapshot is committed), but this is fully intentional and guarded: `drizzle.config.ts` documents the hand-written-SQL policy in prose with an explicit warning against running `db:generate`, and `check-migration-parity.ts` empirically replays the real migration chain against a live-materialized `schema.ts` on every CI run rather than depending on the snapshot chain at all — a stronger guarantee than the snapshot mechanism it's standing in for. **Downgraded to P3** (informational risk for a contributor who ignores both the prose warning and the CI gate) rather than carried forward as P2.

## Coverage confirmation

### Migrations (38/38 read in full)

0000_initial_schema · 0001_auth_tables · 0002_loop_orders · 0003_watcher_cursors
· 0004_orders_redemption · 0005_user_identities · 0006_users_home_currency ·
0007_orders_charge_columns · 0008_orders_loop_asset_payment ·
0009_users_stellar_address · 0010_pending_payouts ·
0011_admin_idempotency_keys · 0012_credit_transactions_period_cursor ·
0013_ledger_constraints · 0014_credit_tx_currency_check ·
0015_credit_tx_reason · 0016_cashback_config_audit_trigger_guard ·
0017_user_credits_primary_key · 0018_pending_payouts_generalise ·
0019_social_id_token_replay_guard · 0020_users_email_unique ·
0021_orders_currency_check · 0022_credit_tx_withdrawal_unique ·
0023_orders_idempotency_key · 0024_pending_payouts_to_address_format ·
0025_user_identities_and_orders_db_checks ·
0026_orders_sweep_aggregate_indexes ·
0027_pending_payouts_user_created_index ·
0028_pending_payouts_compensation_and_withdrawal_uniqueness ·
0029_cashback_config_audit_insert_delete_triggers ·
0030_pending_payouts_asset_checks · 0031_credit_transactions_reason_length ·
0032_user_favorite_merchants · 0033_payment_watcher_skips ·
0034_orders_redemption_backfill · **0035_orders_redeem_revoke_readonly** ·
**0036_perf_admin_and_stats_indexes** ·
**0037_orders_currency_extended_markets** (bold = delta-manifest files, given
extra adversarial scrutiny per the brief).

### Other files read in full

- `apps/backend/src/db/schema.ts` (all 15 tables, every CHECK/index/FK)
- `apps/backend/src/db/client.ts`
- `apps/backend/src/db/users.ts`
- `apps/backend/src/db/migrations/meta/_journal.json` (all 38 entries — dense, idx 0-37, monotonic `when`, tags match filenames exactly, no gap/collision)
- `apps/backend/src/db/migrations/meta/0000_snapshot.json`
- `apps/backend/drizzle.config.ts`
- `apps/backend/src/scripts/check-migration-parity.ts`
- `scripts/migration-parity-allowlist.json`
- `apps/backend/src/db/__tests__/orders-currency-check.test.ts`
- `apps/backend/src/db/__tests__/orders-schema.test.ts`
- `apps/backend/src/db/__tests__/pending-payouts-schema.test.ts`
- `apps/backend/src/db/__tests__/pooled-url.test.ts`
- `apps/backend/src/db/__tests__/users.test.ts`
- `docs/runbooks/migration-rollback.md`
- `docs/deployment.md` (DB roles + env-var sections)

### Cross-read for delta verification (not full-file audits, but specific sections traced against schema/migration claims)

`packages/shared/src/loop-asset.ts` · `apps/backend/src/orders/loop-handler.ts`
(currency validation block) · `apps/backend/src/orders/redeem-crypto.ts` (full)
· `apps/backend/src/orders/__tests__/redeem-crypto-persist.test.ts` (full) ·
`apps/backend/src/orders/redemption-backfill.ts` (concurrency-safety block) ·
`apps/backend/src/orders/fulfillment.ts` (redeem-field write sites) ·
`apps/backend/src/orders/loop-read-handlers.ts` (redeem-field read sites) ·
`apps/backend/src/orders/procurement-redemption.ts` ·
`apps/backend/src/credits/pending-payouts.ts` (full) ·
`apps/backend/src/credits/pending-payouts-transitions.ts` (full) ·
`apps/backend/src/credits/withdrawals.ts` (full) ·
`apps/backend/src/admin/settlement-lag.ts` (query block) ·
`apps/backend/src/admin/payouts-by-asset.ts` (query block) ·
`apps/backend/src/public/cashback-stats.ts` (full) ·
`apps/backend/src/routes/admin-credit-writes.ts` (full) ·
`apps/backend/src/routes/admin-payouts.ts` (full) ·
`apps/backend/src/routes/admin-user-writes.ts` (full) ·
`apps/backend/src/env.ts` (DB + redeem-key + admin-allowlist sections) ·
`apps/backend/src/index.ts` (boot sequence + shutdown handler) ·
`apps/backend/fly.toml` (full) ·
`node_modules/drizzle-orm/pg-core/dialect.js` (`migrate()` implementation,
traced to verify/refute a cross-instance migration-race hypothesis) ·
`apps/backend/src/admin/orders.ts` / `orders-csv.ts` (grepped to confirm
redeem secrets are excluded from admin CSV/list output, not decrypted there).

### Empirical verification

Spun up a disposable `postgres:16-alpine` Docker container (unrelated to the
project's dev DB) to reproduce migration 0035's `REVOKE SELECT (col1, col2)
ON table FROM role` against a role provisioned with the documented
`GRANT SELECT ON ALL TABLES IN SCHEMA public` pattern, confirming the revoke
is a no-op in that configuration (DB-01), then reproduced the correct
table-REVOKE + column-GRANT pattern for comparison. Container removed after
the test; no project data or infrastructure touched.
