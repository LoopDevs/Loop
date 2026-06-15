# V-DB — Database / Schema / Migrations vertical (cold audit 2026-06-15)

Branch `fix/stranded-order-hardening`. Adversarial cold read against code, not
docs/prior-audits. Scope: `apps/backend/src/db/**` (`schema.ts`, `client.ts`,
`users.ts`, all 35 migrations 0000→0034, `meta/_journal.json` +
`0000_snapshot.json`), `apps/backend/drizzle.config.ts`,
`apps/backend/src/scripts/check-migration-parity.ts` +
`scripts/migration-parity-allowlist.json`, `scripts/postgres-init.sh`. Applied
checklist dimension 9 in full. Cross-read order/credit/payout currency gates,
FX path, env.ts DB config, `@loop/shared` currency tuples.

---

## Probe results (the questions asked)

- **Does the migration chain replay 0000→latest and match schema.ts?** Cannot
  run a live DB here, but reasoned the chain table-by-table, column-by-column,
  constraint-by-constraint against `schema.ts`. **No drift found** beyond the two
  intentional allowlisted FK-name pairs and the three trigger entries. Every one
  of the 15 tables, every CHECK, every index, every default, every nullability
  flag in `schema.ts` has a matching DDL statement somewhere in the chain
  (initial CREATE or later ALTER). The parity gate
  (`check-migration-parity.ts`) is genuinely sound: it replays the _production_
  migrator path into a scratch DB, materialises `schema.ts` via
  `generateMigration(empty→schema)` into a second, introspects both catalogs
  (columns/constraints/indexes/triggers/enums) through `pg_get_constraintdef`
  (deparser-normalised so formatting differences don't false-positive), diffs
  them, and _ratchets the allowlist down_ (stale entries fail). This is a strong
  empirical guarantee — better than the journal/snapshot chain it replaces.
- **Numbering gaps/collisions 0033–0039?** None. Migrations are a dense
  0000…0034 (35 files); `_journal.json` has 35 entries idx 0–34 with
  monotonically increasing `when` and tags matching filenames exactly. No
  orphan migration, no orphan journal entry, no gap, no collision. The prompt's
  "0033–0039" framing finds 0033/0034 present and ≥0035 simply nonexistent.
- **`0000_snapshot.json` is stale vs schema.ts** — only the original 5 tables.
  This is intentional (drizzle.config.ts + parity script both document it: the
  repo uses hand-written SQL, `db:generate` is an emergency escape hatch only)
  but it is a live foot-gun — see [P2-02].
- **timestamptz everywhere?** Yes. Every timestamp column in both `schema.ts`
  (all `withTimezone: true`) and every migration (`timestamp with time zone` /
  `timestamptz`) is timezone-aware. Zero naive timestamps. UTC discipline holds.
- **bigint mode for money?** Yes. Every minor-unit / stroops column is
  `bigint('…', { mode: 'bigint' })` and `client.ts` sets
  `types: { bigint: postgres.BigInt }` so values round-trip as native BigInt
  end-to-end (no silent Number truncation past 2^53). No float/`numeric` used
  for money amounts; `numeric(5,2)` is used only for _percentages_, which is
  correct.
- **char(3) currency + currency CHECKs vs ADR 035?** Confirmed. All five
  currency columns are `char(3)` and every one is CHECK-pinned to exactly
  `('USD','GBP','EUR')`: `users.home_currency`, `user_credits.currency`,
  `credit_transactions.currency`, `orders.currency` (catalog), and
  `orders.charge_currency`. ADR 035 extended markets (AED/INR/SAR/AUD/MXN) and
  CAD are deliberately **display-only**; the schema is the hard fail-closed
  fence and the loop-native order handler rejects non-LOOP currencies cleanly at
  400 (`loop-handler.ts:259-267`) before the DB. This is correct posture, not a
  defect — but the order-path extension is unbuilt and the schema is the gate
  (see [P3-04]).
- **Triggers (cashback-config history) correct + preserved?** Yes, and notably
  well-handled. 0000 creates fn+UPDATE trigger; 0016 re-asserts idempotently
  (CREATE OR REPLACE + DROP IF EXISTS + CREATE); 0029 extends the fn to handle
  INSERT/DELETE via `TG_OP` and adds AFTER INSERT / AFTER DELETE triggers. All
  three triggers are allowlisted in the parity gate (drizzle can't model
  triggers). Function body is `OLD`-on-UPDATE (captures prior values) which is
  the right audit semantic. No defect.
- **Partial-unique for at-most-once?** Mostly strong, with one financial gap —
  see [P1-01]. Present: `credit_transactions_interest_period_unique` (interest
  idempotency), `credit_transactions_reference_unique` (cashback/refund/spend/
  withdrawal at-most-once), `orders_user_idempotency_unique`,
  `pending_payouts_order_unique`, `pending_payouts_active_withdrawal_unique`,
  `users_email_loop_native_unique`, `users_ctx_user_id_unique`.
- **Pool / statement_timeout / SSL / lazy connect?** `max` from env (default
  10), `idle_timeout: 20`, `connect_timeout: 10`, lazy (postgres-js connects on
  first query). `statement_timeout` (30s) sent as a startup parameter, _skipped_
  for PgBouncer/pooler hosts (heuristic regex). Two issues: the 30s timeout also
  binds the boot-time migrator on the shared pool ([P2-01]); and no SSL is
  enforced for production DATABASE_URL ([P3-03]).
- **Indexes for hot queries + partial indexes?** Comprehensive and well-reasoned
  (orders pending/procuring/fulfilled partials, redemption-backfill partial,
  payout state/user composites, skip status/created). No obviously-unused index
  found. Minor redundancy noted — see [P3-02].
- **FOR UPDATE patterns the schema supports?** Yes — credits adjustments/
  refunds/withdrawals/interest/compensation all use row locks against
  `user_credits` (composite PK) and `pending_payouts`/`orders` (uuid PK). The
  PKs/composite PKs give stable lockable row identity. No schema obstacle.

---

## Findings

### [P1-01] Duplicate-withdrawal at-most-once leans entirely on `pending_payouts_active_withdrawal_unique`; the credit-tx reference-unique is structurally a no-op for withdrawals

- **severity:** P1
- **file:** `apps/backend/src/db/schema.ts:206-210` (`credit_transactions_reference_unique`); `apps/backend/src/db/migrations/0022_credit_tx_withdrawal_unique.sql`; `0028_…withdrawal_uniqueness.sql`
- **description:** Migration 0022 widened the partial unique
  `(type, reference_type, reference_id) WHERE type IN (cashback,refund,spend,withdrawal)`
  to _include_ withdrawal, and the schema/comment present it as the at-most-once
  fence. But a withdrawal credit-tx references the freshly-inserted
  `pending_payouts.id` (a v4 UUID minted in the same call), so the
  `reference_id` is unique by construction on _every_ call. The index can never
  fire for the realistic "user/operator submits the same withdrawal twice"
  scenario — each attempt gets a new payout UUID and thus a new `reference_id`.
  The _only_ real fence against a double-withdrawal is
  `pending_payouts_active_withdrawal_unique` on
  `(user_id, asset_code, asset_issuer, to_address, amount_stroops) WHERE
kind='withdrawal' AND state IN (pending,submitted,failed) AND
compensated_at IS NULL` (0028).
- **impact:** The system _is_ protected against the common double-submit (0028's
  index holds), so this is not an open money-loss hole today. The P1 is that the
  protection is **single-point** and **non-obvious**: (a) the 0028 index excludes
  `state='confirmed'` and `compensated_at IS NOT NULL` rows by design, so a
  retry that races _after_ the first payout confirms — or after an operator
  compensates a failed one — is permitted to create a second active withdrawal
  for the same amount/destination, and nothing at the credit-tx layer catches
  it; (b) the schema comment over-claims the credit-tx index as a withdrawal
  fence, so a future maintainer could remove/loosen the 0028 index believing the
  reference-unique still guards it. The 0022 migration comment itself admits the
  fresh-UUID problem ("naturally-occurring same payout twice is not the
  concern") but the schema docstring at lines 194-210 does not carry that
  caveat.
- **evidence:** `pending_payouts.id` is `uuid().defaultRandom()` (schema:755);
  withdrawal writer references that id; 0028 index `WHERE state IN
('pending','submitted','failed')` excludes confirmed.
- **fix:** Either (1) add a stronger semantic key the credit-tx index can use
  (e.g. an operator-supplied withdrawal-intent id as `reference_id`), or (2)
  amend the `credit_transactions_reference_unique` docstring (schema:194-210) to
  state explicitly that withdrawal uniqueness is delegated to
  `pending_payouts_active_withdrawal_unique` and the reference-unique entry is
  inert for withdrawals, so the real fence is never accidentally removed. Verify
  the confirmed/compensated race window against the withdrawal writer's locking.
- **ref:** ADR 024 §4; A2-901; A3-007.

### [P2-01] Boot-time migrator shares the 30s `statement_timeout` pool — a future long DDL/data-migration self-aborts mid-deploy

- **severity:** P2
- **file:** `apps/backend/src/db/client.ts:51-87`; `apps/backend/src/env.ts:200-209`
- **description:** `runMigrations()` calls `migrate(db, …)` against the same
  `drizzle(client)` instance whose connections carry
  `statement_timeout=30000` as a startup parameter. Every DDL statement and any
  in-migration `UPDATE` backfill runs under that 30s cap. The env comment
  acknowledges this ("the migrator path runs through the same pool and can take
  longer on a fresh-clone replay") and asserts current migrations stay under 5s
  — true today — but the chain already contains a full-table backfill
  (`0007` `UPDATE orders SET … WHERE charge_minor = 0`) and the schema is
  growing tables (orders, credit_transactions, pending_payouts) that will not
  stay small. A future expand-contract data-migration on a large table will be
  killed at 30s, leaving migrations partially applied (drizzle records a
  migration only on full success, so a timeout mid-statement aborts the deploy
  and may leave a half-applied multi-statement file if breakpoints split it).
- **impact:** Latent deploy-failure / partial-migration risk that grows with row
  count. Not triggered at launch volume.
- **fix:** Run migrations on a dedicated short-lived connection with
  `statement_timeout=0` (or a much higher migration-specific bound), separate
  from the request pool. The `postgres` lib supports a one-off client; or set
  `SET LOCAL statement_timeout = 0` at the head of the migrator's transaction.
  Document that data-migration backfills must be batched regardless.
- **ref:** A2-724; checklist §9 "data migrations safe (batched, no lock storms)".

### [P2-02] `meta/_journal.json` + `0000_snapshot.json` are stale relative to schema.ts — `db:generate` is a live foot-gun that would drop the audit trigger

- **severity:** P2
- **file:** `apps/backend/src/db/migrations/meta/0000_snapshot.json` (only the
  original 5 tables); `apps/backend/drizzle.config.ts`
- **description:** The drizzle snapshot chain stops at the 0000 baseline (5
  tables: credit*transactions, merchant_cashback_config[_history], user_credits,
  users) while `schema.ts` now describes 15 tables. Running `npm run db:generate`
  diffs the current schema against that ancient baseline and emits a giant
  re-creation migration — and because drizzle cannot model triggers, it would
  \_not* re-emit the ADR-011 audit trigger/function, silently dropping the audit
  trail if anyone applied the generated output. `drizzle.config.ts` and the
  parity script both warn about this in prose, and parity/`drizzle-kit check`
  guards the committed state, but nothing structurally prevents a contributor
  from running `db:generate` and committing the result.
- **impact:** Operator/contributor error class. The migration-parity gate would
  _catch_ the resulting drift in CI (so it can't merge silently), which is why
  this is P2 not P1 — but a local `db:migrate` of a bad generated file against a
  shared dev/staging DB could drop the trigger before CI ever runs.
- **fix:** Either re-baseline the snapshot to the current schema (one-time, so
  `db:generate` produces small diffs going forward), or wire `db:generate` to
  refuse to run / print a hard error directing to the hand-written-SQL recipe.
  At minimum, make the parity gate's failure message reference this snapshot
  staleness.
- **ref:** A2-412; A2-703; drizzle.config.ts docstring.

### [P2-03] No reversibility / down-migration story; expand-contract is one-directional

- **severity:** P2
- **file:** all of `apps/backend/src/db/migrations/*.sql`
- **description:** Every migration is forward-only DDL. drizzle-orm's migrator
  has no down path and none of the 35 files ships a documented rollback (a few
  comments mention "rolled back via DROP TABLE X" for 0032/0033 but there is no
  executable down-migration anywhere). Several migrations are _irreversibly_
  destructive without a recorded undo: 0007/0008 drop-and-recreate CHECKs, 0017
  drops the unique index then adds a PK (a crash between them is transaction-safe
  per the comment, but there is no reverse), 0022/0027/0030/0031 drop-and-
  recreate indexes/constraints. The deploy story (runMigrations at boot) means a
  bad migration must be fixed forward under incident pressure.
- **impact:** Operational — incident recovery from a bad migration has no rehearsed
  path. Acceptable at pre-launch single-machine scale; a launch-blocker-adjacent
  gap for a financial ledger.
- **fix:** Adopt the project's own expand-contract discipline explicitly: for any
  breaking change ship the expand migration separately from the contract, and
  record a down-SQL (even if only in a runbook) for each migration. The existing
  `docs/runbooks/migration-rollback.md` is referenced by 0026's comment — verify
  it actually covers the destructive 0007/0008/0017/0022 patterns.
- **ref:** checklist §9 "reversibility / documented irreversibility".

### [P3-01] `0019` / `0032` / `0033` use `CREATE TABLE IF NOT EXISTS` while the rest use bare `CREATE TABLE` — inconsistent idempotency posture

- **severity:** P3
- **file:** `0019_social_id_token_replay_guard.sql`, `0032_user_favorite_merchants.sql`, `0033_payment_watcher_skips.sql` vs `0000/0001/0002/0005/0010/0011`
- **description:** Later table-creating migrations adopted `IF NOT EXISTS` (+
  `IF NOT EXISTS` on their indexes) for partial-apply safety; the earlier ones
  use bare `CREATE TABLE` / `CREATE INDEX`. Since drizzle's migrator wraps each
  file and records success only on completion, a re-run of a bare-CREATE file
  after a partial failure would error on the already-created object. Mixed
  convention means rollback/replay behaviour differs per migration.
- **impact:** Minor — only matters during a partial-apply recovery, which is rare.
- **fix:** Document one convention (the `IF NOT EXISTS` discipline 0016+ adopted)
  in the migration recipe; no need to rewrite history.

### [P3-02] `users_email` plain index is redundant with the partial-unique on `LOWER(email)` for the Loop-native read path

- **severity:** P3
- **file:** `apps/backend/src/db/schema.ts:77` (`index('users_email')`); 0020
- **description:** `users_email` is a plain btree on raw `email`. The dominant
  lookup `findOrCreateUserByEmail` queries `eq(users.email, normalised)` (already
  lowercased), and 0020 added a partial unique on `LOWER(email) WHERE
ctx_user_id IS NULL`. The plain index still serves CTX-proxied rows and
  exact-case lookups, so it is not dead — but its value is now narrow and it
  carries write cost on every user upsert. Worth confirming it is still earning
  its keep vs. an expression index on `LOWER(email)` covering both planes.
- **impact:** Negligible at user-table scale.
- **fix:** Re-evaluate at scale; possibly replace with a single `LOWER(email)`
  expression index. No action needed pre-launch.

### [P3-03] No SSL enforcement on the production DATABASE_URL

- **severity:** P3
- **file:** `apps/backend/src/db/client.ts:57-73`; `apps/backend/src/env.ts:192-197`
- **description:** `postgres(env.DATABASE_URL, {…})` passes no `ssl` option, so
  TLS to Postgres depends entirely on `?sslmode=require` being present in the URL
  string. `env.ts` validates only that it is a `postgres://` URL — there is no
  boot-time check that production traffic is encrypted. The data in transit
  includes ledger balances, redeem codes/PINs (`orders.redeem_*`), OTP hashes,
  and refresh-token hashes.
- **impact:** Low in the current Fly topology (app↔Postgres rides the Fly
  private WireGuard mesh / `.flycast`, so the link is already encrypted), but the
  protection is environmental, not enforced — a future move to an external/
  managed Postgres without `sslmode=require` would silently send ledger data in
  cleartext.
- **fix:** In `NODE_ENV=production`, refine `DATABASE_URL` to require
  `sslmode=require` (or pass `ssl: 'require'`/`'verify-full'` to the client when
  the host isn't a known-private Fly address). Document the carve-out for Fly
  internal hosts.
- **ref:** checklist §16 "encryption in transit".

### [P3-04] ADR-035 extended-market + CAD order path is gated only by the currency CHECK; no migration yet, and a non-loop-native code path could surface a raw CHECK violation

- **severity:** P3
- **file:** `apps/backend/src/db/schema.ts:575-581` (orders currency CHECKs); `packages/shared/src/countries.ts:33-106`
- **description:** AE/IN/SA/AU/MX (ADR 035) and CA display in 6 non-LOOP
  currencies but the schema pins `orders.currency` / `orders.charge_currency` to
  USD/GBP/EUR. The loop-native handler rejects cleanly at 400
  (`loop-handler.ts:259-267`), so the happy path is fine and fail-closed. The
  residual: the schema is the _only_ structural fence, and any future writer
  that builds an order for an extended-market merchant without re-validating
  (e.g. the legacy CTX-proxy order path, or the in-progress ADR-035 order
  extension) would hit a bare DB CHECK violation surfaced as a 500 rather than a
  clean 4xx. There is no migration extending the CHECK and no
  rates/FX-conversion plumbing for those currencies yet (matches the documented
  "order-path support in progress" deferral).
- **impact:** Currently none (display-only enforced upstream). Becomes a real
  edge if the order path is extended without first widening the four
  `*_currency_known` CHECKs in lock-step (as 0021's comment instructs).
- **fix:** When ADR-035 order-path lands, ship one migration touching all four
  `*_currency_known` CHECKs + `user_credits`/`credit_transactions` together, and
  add a clean handler-level currency rejection on every order-create path (not
  just loop-native).
- **ref:** ADR 035; 0021 comment; comprehensive-audit Part IV Phase 3.

### [P3-05] `userCredits.balanceMinor` has no column default (schema + 0000 agree) — every insert must supply it explicitly

- **severity:** P3
- **file:** `apps/backend/src/db/schema.ts:119-121`
- **description:** `balance_minor` is `notNull()` with no default (the comment
  explains drizzle-kit can't JSON-serialise a BigInt default). Schema and
  migration 0000 agree (parity-clean), so this is not drift. The note is purely
  that the safety of every `user_credits` insert depends on callers always
  passing `0n` on first upsert — there is no DB backstop if a future writer
  forgets. The non-negative CHECK would catch a negative but not a missing
  value (the NOT NULL would, with a constraint error rather than a sane 0).
- **impact:** None today (all writers supply it). Defence-in-depth gap only.
- **fix:** Optional — a raw-SQL `DEFAULT 0` in a migration (allowlisted as
  schema-only-can't-represent) would give the backstop, or leave as-is and rely
  on the writer convention. No action required.

---

## Coverage

### Migrations (35/35 read in full)

- `0000_initial_schema` — credit_transactions, merchant_cashback_config[_history],
  user_credits, users; FKs; indexes; audit fn + UPDATE trigger. ✓
- `0001_auth_tables` — otps, refresh_tokens; FK; indexes. ✓
- `0002_loop_orders` — orders table + state/payment-method/sum/non-negative
  CHECKs; FK; pending/ctx_operator indexes. ✓
- `0003_watcher_cursors` — watcher_cursors. ✓
- `0004_orders_redemption` — orders.redeem_code/pin/url. ✓
- `0005_user_identities` — user_identities; FK cascade; provider_sub unique. ✓
- `0006_users_home_currency` — users.home_currency char(3) + CHECK. ✓
- `0007_orders_charge_columns` — charge_minor/charge_currency + backfill UPDATE +
  CHECK + drop/recreate non-negative CHECK. ✓ (backfill one-shot, [P2-01] re timeout)
- `0008_orders_loop_asset_payment` — payment_method CHECK widen (loop_asset). ✓
- `0009_users_stellar_address` — users.stellar_address nullable. ✓
- `0010_pending_payouts` — pending_payouts + state/amount/attempts CHECKs; FKs;
  order-unique + state/user indexes. ✓
- `0011_admin_idempotency_keys` — composite PK; key-length/status CHECKs; FK;
  created_at index. ✓
- `0012_credit_transactions_period_cursor` — period_cursor + interest-only CHECK +
  partial unique. ✓
- `0013_ledger_constraints` — user_credits currency CHECK; reference_unique
  partial (cashback/refund/spend). ✓
- `0014_credit_tx_currency_check` — credit_transactions currency CHECK. ✓
- `0015_credit_tx_reason` — reason column. ✓
- `0016_cashback_config_audit_trigger_guard` — idempotent re-assert fn+trigger. ✓
- `0017_user_credits_primary_key` — drop unique index, add composite PK. ✓
- `0018_pending_payouts_generalise` — order_id nullable; kind col+CHECK; shape
  CHECK. ✓
- `0019_social_id_token_replay_guard` — social_id_token_uses (IF NOT EXISTS). ✓
- `0020_users_email_unique` — partial unique LOWER(email) WHERE ctx_user_id NULL. ✓
- `0021_orders_currency_check` — orders.currency CHECK. ✓
- `0022_credit_tx_withdrawal_unique` — reference_unique widen to withdrawal. ✓
  ([P1-01] — inert for withdrawals)
- `0023_orders_idempotency_key` — idempotency_key col + partial unique. ✓
- `0024_pending_payouts_to_address_format` — to_address regex CHECK. ✓
- `0025_user_identities_and_orders_db_checks` — provider CHECK + payment_memo
  coherence CHECK. ✓
- `0026_orders_sweep_aggregate_indexes` — 3 partial indexes (IF NOT EXISTS). ✓
- `0027_pending_payouts_user_created_index` — drop user index, add composite. ✓
- `0028_…compensation_and_withdrawal_uniqueness` — compensated_at + active-
  withdrawal partial unique. ✓ (real withdrawal fence — [P1-01])
- `0029_cashback_config_audit_insert_delete_triggers` — TG_OP fn + INSERT/DELETE
  triggers. ✓
- `0030_pending_payouts_asset_checks` — asset_code/asset_issuer CHECKs
  (idempotent). ✓
- `0031_credit_transactions_reason_length` — reason length CHECK (idempotent). ✓
- `0032_user_favorite_merchants` — table + composite PK + nonempty CHECK + desc
  index (IF NOT EXISTS). ✓
- `0033_payment_watcher_skips` — table + reason/status CHECKs + status/created
  index (IF NOT EXISTS). ✓
- `0034_orders_redemption_backfill` — 2 cols + partial backfill-pending index. ✓
- `meta/_journal.json` — 35 entries idx 0–34, dense, tags match files. ✓
- `meta/0000_snapshot.json` — stale (5 tables only) — [P2-02]. ✓

### Schema tables (15/15 in schema.ts, all matched to migrations)

users · user_credits · credit_transactions · merchant_cashback_configs ·
merchant_cashback_config_history · otps · refresh_tokens · orders ·
watcher_cursors · payment_watcher_skips · user_identities · pending_payouts ·
admin_idempotency_keys · social_id_token_uses · user_favorite_merchants.

### Supporting files

- `client.ts` — pool/timeout/pooler-detection/bigint mode. ✓ ([P2-01], [P3-03])
- `users.ts` — upsert (targetWhere on partial unique), find-or-create (ON
  CONFLICT DO NOTHING + re-select race-safe). ✓ No defect.
- `drizzle.config.ts` — hand-written-SQL posture documented. ✓ ([P2-02])
- `check-migration-parity.ts` + allowlist — sound, ratcheting. ✓ No defect.
- `postgres-init.sh` — creates loop_test once on fresh volume. ✓ No defect.
- `__tests__/` — orders-schema, pending-payouts-schema, pooled-url, users. (Not
  the V-DB focus; existence noted.)

---

## Summary

**Severity counts:** P0 = 0 · P1 = 1 · P2 = 3 · P3 = 5 · files examined = 41
(15 schema tables + 35 migrations counted as files + journal + snapshot +
client.ts + users.ts + drizzle.config.ts + parity script + allowlist +
postgres-init.sh; overlapping with the 35-migration count).

The DB layer is the most mature vertical seen in this audit. Constraint coverage
is genuinely thorough — every currency/state/enum/sign/sum/format invariant is
pinned at the DB as defence-in-depth, with NULL-tolerant CHECKs where
appropriate. Money is bigint end-to-end, timestamps are universally timestamptz,
the audit trigger is preserved with idempotent re-assertion, and the
migration-parity gate is a real empirical guarantee rather than docs. No drift,
no numbering gap, no naive timestamp, no float money, no orphan migration.

The one P1 ([P1-01]) is not an open money hole — duplicate withdrawals _are_
blocked by `pending_payouts_active_withdrawal_unique` — but the protection is
single-point, has a confirmed/compensated race carve-out, and is mis-described
in the schema as also being guarded by the (structurally-inert) credit-tx
reference-unique; the risk is a future maintainer removing the real fence. The
P2s are latent-at-scale (migrator timeout, snapshot staleness, no down-migration
story) rather than launch blockers. No P0. Launch-readiness for the DB vertical:
**green with the [P1-01] doc/fence clarification recommended before scaling
withdrawals.**
