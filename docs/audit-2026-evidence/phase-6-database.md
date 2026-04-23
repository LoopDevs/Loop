# Phase 6 — Database & Data Layer

- Commit SHA: `450011ded294b638703a9ba59f4274a3ca5b7187`
- Auditor scope: pass-3 plan §Phase 6 + G4-04/05/06 + G5-29..G5-34
- Method: replayed every migration against an ephemeral Postgres 16 in
  docker (`loop-audit-pg`, port 55432), dumped schema + constraints +
  indexes with `pg_dump` / `information_schema` / `pg_catalog`, then
  diffed against `apps/backend/src/db/schema.ts` and static-analysed
  every write path under `apps/backend/src/**`.
- Absolute rules honoured: no edits to code, tracker, or migrations; no
  production-DB contact; evidence container stopped on completion.

---

## Replay log

```
docker run -d --rm --name loop-audit-pg -e POSTGRES_USER=audit \
  -e POSTGRES_PASSWORD=audit -e POSTGRES_DB=audit \
  -p 55432:5432 postgres:16

# Sequential apply of every *.sql in the migrations folder, ON_ERROR_STOP=1.
# Ordering is filename-sorted (0000..0011), which matches the journal
# ordering except that 0011 is NOT listed in _journal.json at all.
for f in 0000_initial_schema.sql … 0011_admin_idempotency_keys.sql; do
  psql -v ON_ERROR_STOP=1 < "$f"
done
```

All 12 migrations applied cleanly. Relevant outputs (trigger install,
constraint DDL, backfill UPDATE on 0007) captured under finding
references.

---

## Per-table: schema.ts ↔ actual schema parity

| Table                              | schema.ts columns                                                                        | Actual DB columns                                                                                                                                                    | Δ                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `users`                            | id, ctx_user_id, email, is_admin, home_currency, stellar_address, created_at, updated_at | matches                                                                                                                                                              | **drift: email index is case-sensitive btree; all queries use LOWER() / ilike — index is unused** (A2-707)                       |
| `user_credits`                     | user_id, currency, balance_minor, updated_at                                             | matches                                                                                                                                                              | **NO PRIMARY KEY** — only a unique index. Drizzle declaration lacks `.primaryKey()` on the composite (A2-702)                    |
| `credit_transactions`              | id, user_id, type, amount_minor, currency, reference_type, reference_id, created_at      | matches                                                                                                                                                              | no CHECK on `currency` column; arbitrary 3-char string accepted (A2-704)                                                         |
| `merchant_cashback_configs`        | merchant_id PK + 6 columns + CHECKs                                                      | matches                                                                                                                                                              | trigger `merchant_cashback_configs_audit` NOT represented in schema.ts — drizzle-kit would drop it on the next generate (A2-703) |
| `merchant_cashback_config_history` | 7 columns                                                                                | matches                                                                                                                                                              | no FK to configs (intentional per ADR 011); no check on `active`/pcts                                                            |
| `orders`                           | 28 columns                                                                               | matches                                                                                                                                                              | no CHECK enum on `currency` (catalog side); only `charge_currency` is enum-bound (A2-705)                                        |
| `otps`                             | 7 columns                                                                                | matches                                                                                                                                                              | no FK to users (intentional — see schema.ts:240)                                                                                 |
| `refresh_tokens`                   | 8 columns                                                                                | matches                                                                                                                                                              | no CHECK on (revoked_at, replaced_by_jti) consistency                                                                            |
| `watcher_cursors`                  | name PK, cursor, updated_at                                                              | matches                                                                                                                                                              | —                                                                                                                                |
| `user_identities`                  | 6 columns                                                                                | matches                                                                                                                                                              | no CHECK on `provider` enum (A2-712)                                                                                             |
| `pending_payouts`                  | 16 columns                                                                               | matches                                                                                                                                                              | —                                                                                                                                |
| `admin_idempotency_keys`           | composite PK + CHECKs                                                                    | **PK name mismatch** — schema.ts uses `uniqueIndex('admin_idempotency_keys_pk_idx')`, migration installs `CONSTRAINT admin_idempotency_keys_pk PRIMARY KEY` (A2-701) |

---

## Constraint coverage matrix (business invariant → enforced-by)

| Invariant                                                          | DB       | App                        | Drift                                                                                                            |
| ------------------------------------------------------------------ | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `user_credits.balance_minor >= 0`                                  | ✅ CHECK | ✅                         | —                                                                                                                |
| Credit txn sign follows type                                       | ✅ CHECK | ✅                         | —                                                                                                                |
| Credit txn type in known set                                       | ✅ CHECK | ✅                         | —                                                                                                                |
| Orders state is in enum                                            | ✅ CHECK | ✅                         | —                                                                                                                |
| Orders payment_method in enum                                      | ✅ CHECK | ✅                         | —                                                                                                                |
| `orders.charge_currency` in {USD,GBP,EUR}                          | ✅ CHECK | ✅                         | —                                                                                                                |
| `orders.currency` (catalog) in known ISO                           | ❌       | only zod at handler edge   | **A2-705** — a schema drift / backdoor write lands any 3-char string; credit_transactions.currency same (A2-704) |
| Orders cashback pct sum ≤ 100                                      | ✅ CHECK | ✅                         | —                                                                                                                |
| Orders minor amounts ≥ 0                                           | ✅ CHECK | ✅                         | —                                                                                                                |
| `user_identities.provider` ∈ {google, apple}                       | ❌       | zod SOCIAL_PROVIDERS union | **A2-712**                                                                                                       |
| `admin_idempotency_keys.key` 16..128 chars                         | ✅ CHECK | ✅                         | —                                                                                                                |
| `admin_idempotency_keys.status` ∈ [100, 600)                       | ✅ CHECK | ✅                         | —                                                                                                                |
| Pending-payout state enum                                          | ✅ CHECK | ✅                         | —                                                                                                                |
| Pending-payout amount > 0                                          | ✅ CHECK | ✅                         | —                                                                                                                |
| Users home_currency enum                                           | ✅ CHECK | ✅                         | —                                                                                                                |
| `users.email` unique                                               | ❌       | app-only find-or-create    | **A2-706** — documented hole in schema; duplicate Loop-native users race-possible                                |
| `refresh_tokens.revoked_at ↔ replaced_by_jti` coherence            | ❌       | app                        | **A2-713** — only a revoked token should carry a `replaced_by_jti`                                               |
| `orders.payment_memo` present when method in {xlm,usdc,loop_asset} | ❌       | app                        | A2-714 (low)                                                                                                     |
| `pending_payouts.to_address` well-formed G… address                | ❌       | app boundary               | A2-715 (low)                                                                                                     |

---

## Index coverage matrix

| Query pattern (caller)                                                                                                                                 | Index                                                            | Adequate?                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `users WHERE id = ?`                                                                                                                                   | users_pkey                                                       | ✅                                                                                                                              |
| `users WHERE ctx_user_id = ?`                                                                                                                          | partial unique                                                   | ✅                                                                                                                              |
| `users WHERE LOWER(email) = ? / ilike(email, ?)`                                                                                                       | `users_email` (btree text, case-sensitive)                       | **❌** — planner cannot use it for `LOWER()` / `ILIKE` unless a functional index is present. Sequential scan at scale. (A2-707) |
| `orders WHERE user_id = ? ORDER BY created_at DESC`                                                                                                    | `orders_user_created`                                            | ✅                                                                                                                              |
| `orders WHERE state = 'pending_payment'` (watcher)                                                                                                     | `orders_pending_payment` (partial)                               | ✅                                                                                                                              |
| `orders WHERE state = 'procuring' AND procured_at < cutoff` (sweep)                                                                                    | —                                                                | **❌** — falls back to sequential scan on orders (A2-708)                                                                       |
| `orders WHERE merchant_id = ? AND state = 'fulfilled' AND fulfilled_at >= since` (merchant-stats, merchant-top-earners, merchant-flywheel-stats, etc.) | only `orders_user_created`                                       | **❌** — every merchant aggregate is a sequential scan + filter. 16 admin handlers hit this shape (A2-709)                      |
| `orders WHERE state = 'fulfilled' AND fulfilled_at ≥ since` (fleet)                                                                                    | —                                                                | **❌** (A2-709)                                                                                                                 |
| `orders WHERE ctx_operator_id = ? AND created_at >= since`                                                                                             | `orders_ctx_operator` alone; no (operator, created_at) composite | partial — operator index picks row set, then filter on created_at                                                               |
| `credit_transactions WHERE user_id = ? ORDER BY created_at DESC`                                                                                       | `credit_transactions_user_created`                               | ✅                                                                                                                              |
| `credit_transactions WHERE reference_type=? AND reference_id=?`                                                                                        | `credit_transactions_reference`                                  | ✅                                                                                                                              |
| `pending_payouts WHERE state='pending' ORDER BY created_at`                                                                                            | `pending_payouts_state_created`                                  | ✅                                                                                                                              |
| `pending_payouts WHERE order_id = ?`                                                                                                                   | unique index                                                     | ✅                                                                                                                              |
| `otps` find-latest-live                                                                                                                                | `otps_email_expires`                                             | ✅ (adequate, not covering)                                                                                                     |
| `refresh_tokens WHERE expires_at < now` (cleanup)                                                                                                      | `refresh_tokens_expires`                                         | ✅                                                                                                                              |
| `admin_idempotency_keys WHERE (admin_user_id, key)` lookup                                                                                             | PK                                                               | ✅                                                                                                                              |
| `admin_idempotency_keys WHERE created_at < now - 24h` (cleanup)                                                                                        | `admin_idempotency_keys_created_at`                              | ✅                                                                                                                              |
| `user_credits WHERE user_id = ? AND currency = ?`                                                                                                      | unique                                                           | ✅                                                                                                                              |

### Index bloat (G4-05)

- `refresh_tokens_user` + `refresh_tokens_pkey` (jti) — the user index
  is redundant _only if_ nothing queries by user alone; the cleanup path
  DOES use it, so retain.
- `pending_payouts_user` is a prefix-only index for user-scoped list;
  admin list also filters by state — a `(user_id, created_at)` composite
  would give better ordering for `listPayoutsForUser` which orders by
  `created_at DESC`. Minor (A2-716).
- No dead/unused indexes detectable statically; `pg_stat_user_indexes`
  probe deferred — no prod telemetry access (live DB not in scope).

---

## Transaction isolation walk (G4-04)

Drizzle/`postgres-js` default: `READ COMMITTED`. Every ledger-writing
path was read and classified.

| Writer                                                      | `db.transaction`? | Lock strategy                                                                | Verdict                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders/transitions.ts::markOrderFulfilled`                 | ✅                | state-guarded UPDATE + INSERT + upsert on (user_id,currency) unique          | Adequate under RC because each row-level step is serialised by Postgres row locks. The `SELECT users.stellarAddress` inside the txn is NOT `FOR UPDATE` — a user updating `stellar_address` mid-fulfillment can race the read (A2-717, low — payout row snapshots the address anyway).                                                    |
| `credits/adjustments.ts::applyAdminCreditAdjustment`        | ✅                | `SELECT … FOR UPDATE` on `user_credits` row                                  | Correct; the FOR UPDATE is the right pessimistic lock for the read-modify-write.                                                                                                                                                                                                                                                          |
| `credits/accrue-interest.ts::accrueOnePeriod`               | ✅ (per user)     | **NONE** — reads balance outside the txn, writes inside using the stale read | **Critical — A2-700.** Concurrent cashback credit during accrual tick overwrites itself. Also: the UPDATE only filters by `user_id` (not `currency`) — a user with >1 currency row has ALL rows overwritten to `staleBalance + accrual` of the first one. Ledger invariant (`balance_minor == SUM(credit_transactions)`) silently broken. |
| `auth/identities.ts::resolveOrCreateUserForIdentity` step 3 | ✅                | no explicit lock                                                             | Fine — concurrent creates contend on the `user_identities_provider_sub` unique index and fail loudly. Step 2 is outside a txn and a concurrent insert can duplicate-link (A2-718, low).                                                                                                                                                   |
| `payments/payout-worker.ts::payOne` via markPayoutSubmitted | —                 | state-guarded UPDATE                                                         | Correct — race with another worker loses the UPDATE, returns null.                                                                                                                                                                                                                                                                        |
| `orders/transitions.ts::markOrderPaid/Procuring/Failed`     | —                 | state-guarded UPDATE                                                         | Correct — idempotent.                                                                                                                                                                                                                                                                                                                     |
| `auth/otps.ts::incrementOtpAttempts`                        | —                 | plain UPDATE                                                                 | Increments ALL unconsumed rows for the email; mostly harmless but means a second live OTP cannot live in parallel without cross-attempt bleed (A2-719, low).                                                                                                                                                                              |

**No path uses `SERIALIZABLE`.** For the ledger, `FOR UPDATE` on the
balance row (adjustments.ts pattern) is the correct discipline; its
absence in `accrue-interest.ts` is the single critical finding.

---

## Migration non-blocking review (G4-06)

Every `ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT <const>`:

- `0006_users_home_currency.sql:7` — `DEFAULT 'USD'`, constant. PG11+
  metadata-only change (`atthasmissing`). ✅
- `0007_orders_charge_columns.sql:16-17` — `DEFAULT 0`, `DEFAULT 'USD'`.
  Metadata-only. ✅ But the **`UPDATE orders SET charge_minor =
face_value_minor WHERE charge_minor = 0`** at line 21-24 of 0007 is a
  full-table UPDATE that acquires a row lock on every row — long-running
  under load, writer-blocking. Pre-launch this is acceptable; flagged
  A2-710 so future migrations don't adopt the pattern.
- All other ALTERs are pure DDL without DEFAULT-valued backfill. ✅

No migration contains seed / fixture data — only the trigger helper
`INSERT INTO merchant_cashback_config_history` (inside the trigger body;
fires per-UPDATE, not at migration time).

Rollback plans: **no `down.sql` exists for any migration; no in-repo
doc of a rollback procedure** (A2-711, medium). ADR 012 does not
address rollback at all.

---

## Migrator / journal drift (critical)

`apps/backend/src/db/migrations/meta/_journal.json` lists 11 entries
(idx 0..10, tags `0000_initial_schema` .. `0010_pending_payouts`).

**Migration `0011_admin_idempotency_keys.sql` is NOT in the journal.**

Drizzle's `readMigrationFiles` (node_modules/drizzle-orm/migrator.js:12)
iterates strictly over `journal.entries` — it does not scan the folder
for additional `.sql` files. `runMigrations()` in
`apps/backend/src/db/client.ts:42` is the only migrator wired into boot
(`apps/backend/src/index.ts`).

Net effect: **on a fresh deploy, `admin_idempotency_keys` is never
created.** Every admin write protected by ADR-017 idempotency headers
will throw on `SELECT / INSERT` against a non-existent relation. This
has shipped because nobody has deployed from-scratch since 0011 landed
(existing dev + any pre-0011 environment has the table from the manual
replay I did by piping `ls 0*.sql | sort`).

Further: the `meta/` folder only has `0000_snapshot.json`, no snapshots
for 0001..0011. Any future `drizzle-kit generate` pass will regenerate
a snapshot from `schema.ts` and propose a fresh migration for every
difference (including dropping the `merchant_cashback_configs_audit`
trigger, the `admin_idempotency_keys_pk` constraint name, etc.).

Tracked as **A2-720 (Critical)**.

---

## PII / encryption-at-rest

| Column                                 | PII class                                               | At-rest encryption        | Log redaction                                      |
| -------------------------------------- | ------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| `users.email`                          | personal data                                           | Fly volume LUKS (default) | should check Pino redaction — out of scope Phase 6 |
| `users.stellar_address`                | pseudonymous wallet                                     | Fly volume                | "                                                  |
| `user_identities.email_at_link`        | personal data                                           | Fly volume                | "                                                  |
| `user_identities.provider_sub`         | external id                                             | Fly volume                | "                                                  |
| `orders.redeem_code/pin/url`           | **bearer secret** (the gift card)                       | **Fly volume only**       | none observed                                      |
| `otps.code_hash`                       | hash only                                               | n/a                       | —                                                  |
| `refresh_tokens.token_hash`            | hash only                                               | n/a                       | —                                                  |
| `refresh_tokens.jti`                   | correlation id                                          | Fly volume                | —                                                  |
| `admin_idempotency_keys.response_body` | may contain PII (admin response bodies serialized JSON) | Fly volume                | none observed — A2-721                             |

- No `pgcrypto` / envelope encryption anywhere; ADR 009 / schema.ts:380
  explicitly accepts this as current posture.
- **A2-722** — `admin_idempotency_keys.response_body` stores the exact
  admin response JSON for 24h. An admin panel response may include user
  email / balance / order redemption data; the row has no scrub path.

---

## Connection / pool / runtime (G5-29..G5-34)

- `postgres-js` pool: `max: env.DATABASE_POOL_MAX` (default 10),
  `idle_timeout: 20s`, `connect_timeout: 10s`. Per-instance 10 × N
  instances vs Fly Postgres connection limit — deferred probe (no
  prod access), but 10 × default Fly "small" Postgres cap (20..100)
  is at-risk if autoscaling hits 10+ replicas (A2-723).
- `statement_timeout`: **not set** (grep `SET LOCAL|statement_timeout`
  returns 0 hits in `apps/backend/src/**`). A runaway admin aggregate
  (merchant-stats, reconciliation full-scan) can monopolise a pool
  connection indefinitely (A2-724, medium).
- `idle_in_transaction_session_timeout`: not set — a crashed handler
  mid-txn holds locks until TCP timeout.
- Autovacuum / VACUUM strategy: no overrides in any migration or init
  script; Postgres defaults rely on table-level autovacuum. Deferred
  probe — no prod telemetry.
- Read replica topology: none configured (docker-compose has a single
  db service; fly.toml backend declaration — out of scope here,
  Phase 16). Admin CSV endpoints run against primary.
- pgbouncer: not used; direct `postgres-js` pool.
- Long-query cancellation on client abort: `postgres-js` supports
  request cancellation but Hono handlers do not plumb `c.req.raw.signal`
  into drizzle calls anywhere I could find (grep
  `AbortSignal|signal:` in db/_ / admin/_: 0 hits in DB layer). A
  client aborting a 30s admin query still burns the connection.
  (A2-725, medium.)

---

## Findings

### A2-700 — Interest accrual is not concurrency-safe and corrupts the ledger (Critical)

**File:** `apps/backend/src/credits/accrue-interest.ts:72-110`.
**Evidence:** Reads `(userId, currency, balanceMinor)` in a single
`SELECT` (line 72-79), iterates, opens a txn per row (line 95),
INSERTs the `credit_transactions` row, then `UPDATE userCredits SET
balance_minor = <staleBalance> + accrual WHERE user_id = <userId>`
(line 107, 109). Two bugs:

1. The UPDATE filter has no `eq(userCredits.currency, row.currency)`
   — if the user has rows in two currencies, **both** rows are
   overwritten to the same scalar (the accrual is for one specific
   row). Ledger vs balance materialisation silently diverges.
2. Even if the currency filter were correct, the write uses the
   pre-txn snapshot of `balanceMinor`; a concurrent `markOrderFulfilled`
   cashback UPDATE between the SELECT and this UPDATE is lost when
   the stale value overwrites.
   **Impact:** Ledger invariant breaks; users lose cashback silently;
   reconciliation endpoint won't catch it because the credit_transactions
   row IS written — only the balance diverges.
   **Remediation:** open the txn around the `SELECT ... FOR UPDATE` on
   the balance row, recompute accrual inside the txn, UPDATE with both
   `user_id = ? AND currency = ?`. Match the pattern already used in
   `credits/adjustments.ts:52-102`.

### A2-701 — Drizzle schema declares a uniqueIndex where the migration installed a PRIMARY KEY constraint (High)

**Files:** `apps/backend/src/db/schema.ts:600` vs
`apps/backend/src/db/migrations/0011_admin_idempotency_keys.sql:15`.
**Evidence:** schema.ts names `uniqueIndex('admin_idempotency_keys_pk_idx').on(t.adminUserId, t.key)`.
Migration installs `CONSTRAINT "admin_idempotency_keys_pk" PRIMARY KEY ("admin_user_id", "key")`.
Also no `.primaryKey()` helper on the schema.ts composite.
**Impact:** A future `drizzle-kit generate` against schema.ts + an
empty meta folder will emit a migration to DROP the PK and ADD the
uniqueIndex — a silent, destructive migration.
**Remediation:** declare the composite PK in schema.ts; drop the
parallel uniqueIndex.

### A2-702 — `user_credits` has no primary key (High)

**File:** `apps/backend/src/db/schema.ts:100-120` +
`apps/backend/src/db/migrations/0000_initial_schema.sql:43-49,65`.
**Evidence:** Table declared with a unique index on (user_id, currency)
but no PK. `\d+ user_credits` confirms only the unique index exists.
**Impact:** logical-replication tooling and many ORMs require a PK;
drizzle-kit snapshots would not propose one; debugging ergonomics
suffer (`ctid` instead of a real identifier).
**Remediation:** promote the unique index to a composite PK.

### A2-703 — `merchant_cashback_configs_audit` trigger is not modelled in schema.ts (High)

**File:** `apps/backend/src/db/migrations/0000_initial_schema.sql:68-86`
(trigger + function installed) vs `schema.ts` (no trigger declaration —
drizzle does not model triggers at all in pg-core).
**Evidence:** `\d+ merchant_cashback_configs` shows the trigger; schema.ts line 202-224 only declares the history table.
**Impact:** the next `drizzle-kit generate` pass will not reference the
trigger; a maintainer who runs "sync schema from DB" could drop it
accidentally. The trigger is the sole guarantee of ADR-011 audit trail.
**Remediation:** either pin the trigger in a separate `.sql` managed
outside drizzle (document), or add a CI check that verifies it
survives schema diffs.

### A2-704 — `credit_transactions.currency` has no ISO CHECK (High)

**File:** `apps/backend/src/db/migrations/0000_initial_schema.sql:1-16`.
**Evidence:** `pg_constraint` shows only `_type_known` and `_amount_sign`
CHECKs on this table. Any 3-char string — `'XXX'`, `'   '`, lowercase
`'usd'` — can land.
**Impact:** a bug in a write path could pin a ledger row to a currency
that has no user_credits row and no matching LOOP asset; balance
replay would compute incorrectly.
**Remediation:** add `CHECK (currency IN ('USD','GBP','EUR'))` parity
with `users.home_currency`.

### A2-705 — `orders.currency` (catalog side) has no ISO CHECK (High)

**File:** `apps/backend/src/db/migrations/0002_loop_orders.sql:25-33`.
**Evidence:** only `orders_charge_currency_known` is enum-bound; the
catalog-side `currency` has no check.
**Impact:** a drift in the CTX catalog + a bypass of the zod parse at
the handler boundary writes a malformed currency. The reconciliation
aggregator groups by `currency` — a single bad row splits the bucket.
**Remediation:** add a CHECK on the known CTX catalog-currency set
(documented list broader than home-currency — USD, GBP, EUR, CAD,
AUD, EUR, etc.).

### A2-706 — `users.email` has no unique index (High)

**File:** `apps/backend/src/db/schema.ts:50-81`;
`apps/backend/src/db/users.ts:85-107` explicitly documents the race.
**Evidence:** only a non-unique `users_email` btree index. The
`findOrCreateUserByEmail` path acknowledges the race (lines 82-88)
and defers to "a future migration."
**Impact:** two concurrent `verify-otp` on the same fresh email create
two `users` rows; credits, orders, refresh tokens fork. Pre-launch
impact is low traffic; post-launch the race fires regularly on
simultaneous logins across devices.
**Remediation:** `CREATE UNIQUE INDEX ON users (LOWER(email))
WHERE ctx_user_id IS NULL;` — partial unique on the loop-native path.

### A2-707 — `users_email` index is case-sensitive btree but every query is LOWER()/ILIKE (Medium)

**File:** `apps/backend/src/db/schema.ts:75`.
**Evidence:** `apps/backend/src/admin/users-list.ts:80` —
`LOWER(${users.email}) LIKE ${pattern}`;
`apps/backend/src/admin/user-by-email.ts:88` —
`eq(sql\`LOWER(${users.email})\`, normalised)`;
`apps/backend/src/admin/user-search.ts:96`—`ilike(users.email, pattern)`.
**Impact:** the `users_email`index cannot serve any of these queries.
Admin lookups by email scan sequentially.
**Remediation:** replace with a functional index on`LOWER(email)`;
standardise handler and ingest paths to store + query normalised email.

### A2-708 — No index for `orders` stuck-procurement sweep (Medium)

**File:** `apps/backend/src/orders/transitions.ts:283-295`;
`apps/backend/src/db/schema.ts:398-407`.
**Evidence:** `sweepStuckProcurement` filters on
`state = 'procuring' AND procured_at < cutoff`. No partial index like
the `pending_payment` one. `orders_user_created` does not apply.
**Impact:** full-table scan every sweep tick. Runs fine at 0 rows
today; at production scale blocks a connection every tick.
**Remediation:** add partial index
`ON orders (procured_at) WHERE state='procuring'`.

### A2-709 — No (merchant_id, state, fulfilled_at) index (Medium)

**File:** `apps/backend/src/admin/merchant-stats.ts:116-135`;
`merchant-top-earners.ts:120-135`; `merchant-flywheel-stats.ts:95-110`;
`merchant-flywheel-activity.ts:130-145`; `supplier-spend.ts`;
`payment-method-activity.ts:75-90`; plus ~12 more admin aggregates.
**Evidence:** every shape is `WHERE merchant_id=? AND state='fulfilled'
AND fulfilled_at >= since` or `WHERE state='fulfilled' AND
fulfilled_at >= since`. Only `orders_user_created` exists today.
**Impact:** every merchant drill-down, every fleet dashboard, every
CSV export does a sequential scan + filter. Works at 0 rows; is the
dashboard stall story at scale.
**Remediation:** at minimum a partial index
`ON orders (merchant_id, fulfilled_at) WHERE state='fulfilled'`
and a second `ON orders (fulfilled_at) WHERE state='fulfilled'` for
the fleet cut.

### A2-710 — 0007 backfill is a full-table UPDATE (Low, pre-launch)

**File:** `apps/backend/src/db/migrations/0007_orders_charge_columns.sql:21-24`.
**Evidence:** `UPDATE orders SET charge_minor = face_value_minor,
charge_currency = currency WHERE charge_minor = 0`.
**Impact:** at 0 rows today this is instant. Under load it would lock
every row for the duration. Flag the pattern so future migrations
adopt the "backfill in chunks" discipline.
**Remediation:** doc + ADR addition; keep this migration as-is.

### A2-711 — No rollback procedure for any migration (Medium)

**File:** `apps/backend/src/db/migrations/**` (no `down.sql`; no
`docs/rollback.md`; no guidance in ADR 012 or `docs/deployment.md`).
**Evidence:** grep for "rollback" in `apps/backend/src/db` returns 0.
**Impact:** a bad migration has no documented reverse; ops is reduced
to a point-in-time restore (itself unrehearsed per Phase 6 scope).
**Remediation:** either adopt drizzle-kit's `.down.sql` convention or
a written rollback for each migration in the PR description, with
CI check.

### A2-712 — `user_identities.provider` has no enum CHECK (Medium)

**File:** `apps/backend/src/db/migrations/0005_user_identities.sql`.
**Evidence:** only zod `SOCIAL_PROVIDERS = ['google','apple']` guards
at the handler edge; no DB-level check.
**Remediation:** `CHECK (provider IN ('google','apple'))`.

### A2-713 — `refresh_tokens (revoked_at, replaced_by_jti)` coherence not enforced (Low)

**File:** `apps/backend/src/db/schema.ts:276-297`.
**Evidence:** both nullable; nothing prevents a live row with a
`replaced_by_jti` set or a revoked row without one. App code doesn't
appear to read these pathologically but drift is invisible.
**Remediation:** `CHECK ((revoked_at IS NULL) = (replaced_by_jti IS NULL))`
or similar.

### A2-714 — `orders.payment_memo` nullability not correlated with payment_method (Low)

**File:** schema.ts:358-361. App pins a memo on on-chain methods but
DB doesn't enforce.
**Remediation:** CHECK `(payment_method = 'credit' OR payment_memo IS NOT NULL)`.

### A2-715 — `pending_payouts.to_address` not shape-validated in DB (Low)

**File:** migration 0010. DB accepts any string; app zod validates at
the boundary.
**Remediation:** `CHECK (to_address ~ '^G[A-Z2-7]{55}$')` mirroring
the Stellar address RE.

### A2-716 — `pending_payouts_user` is not a covering index for user list (Low)

**File:** schema.ts:564. `listPayoutsForUser` orders by `created_at
DESC`; a `(user_id, created_at)` composite would avoid the sort.
**Remediation:** replace the single-column index with a composite.

### A2-717 — `users.stellar_address` read inside fulfill txn is not FOR UPDATE (Low)

**File:** `apps/backend/src/orders/transitions.ts:170-176`.
**Evidence:** `tx.select().from(users).where(eq(users.id, ...))` with
no `.for('update')`. A user updating their `stellar_address` after the
ledger write but before the pending_payouts INSERT lands at the old
address. The pending_payouts row pins the address so the ultimate
payment is consistent with what was read — comment at schema.ts:539
acknowledges this is intentional. Leaving Low as a nudge to document
the intent.

### A2-718 — Social-login step 2 has no txn (Low)

**File:** `apps/backend/src/auth/identities.ts:58-76`.
**Evidence:** `findFirst(users) → insert(user_identities)` is two
statements; a concurrent resolve on the same (provider, sub) could
both hit step 2, both see the email row, both INSERT — one wins on
the unique index, the loser's `onConflictDoNothing` eats the error.
No correctness impact, confirms the defence. Kept for traceability.

### A2-719 — `incrementOtpAttempts` bumps attempts on all live rows for an email (Low)

**File:** `apps/backend/src/auth/otps.ts:123-132`. Plus `findLiveOtp`
uses `lte(attempts, MAX)` which permits attempts = MAX (one-off
6-attempt ceiling instead of 5).
**Impact:** tiny — a user with two in-flight OTPs on the same email
loses attempts counter independence.
**Remediation:** scope UPDATE to the row returned from `findLiveOtp`;
switch `lte` → `lt`.

### A2-720 — Migration 0011 is not in `_journal.json`, so fresh deploys skip it (Critical)

**Files:** `apps/backend/src/db/migrations/meta/_journal.json` (11
entries, stops at idx 10); `apps/backend/src/db/migrations/0011_admin_idempotency_keys.sql`
(exists on disk); `apps/backend/src/db/client.ts:42-45`
(runMigrations uses the drizzle migrator); `node_modules/drizzle-orm/migrator.js:12` (drizzle iterates journal.entries, not the folder).
**Impact:** any fresh `runMigrations()` invocation — boot of a new
Fly instance, clone to staging, test harness setup — skips 0011.
The admin-idempotency path then throws on `admin_idempotency_keys`
not existing, breaking every ADR-017 admin write.
**Also:** `meta/` only has `0000_snapshot.json` — drizzle-kit has not
been re-run since 2024-11-ish. A fresh `drizzle-kit generate` will
emit a 12th migration that drops the trigger + renames the PK, plus
whatever else schema.ts diverges on.
**Remediation:** regenerate the journal + snapshots via
`drizzle-kit generate` (no schema change), verify the 12 entries +
12 snapshots, commit. Add a CI gate that fails if the number of
`.sql` files != number of journal entries.

### A2-721 — `admin_idempotency_keys.response_body` stores admin JSON for 24h with no scrub (Medium)

**File:** `apps/backend/src/db/migrations/0011_admin_idempotency_keys.sql:13`.
**Evidence:** `response_body text NOT NULL`. Admin responses include
user email, balance, order redemption. 24h retention is comment-only
(`admin_idempotency_keys_created_at` index + "nightly cleanup sweep").
**Remediation:** ensure the sweep job exists (separate finding for
Phase 5/17 — out of scope here) and scope what's stored (status +
hash of body would be sufficient if the body is reconstructible).

### A2-722 — Orders redemption fields plaintext at rest (Medium)

**File:** schema.ts:380-384. Gift-card code + PIN + URL stored
plaintext. ADR 009 implicitly accepts this; schema.ts comment says
"Postgres-at-rest encryption on Fly volumes is the current defence;
a future slice can wrap with a per-row envelope once we have KMS."
**Remediation:** per-row envelope with a rotatable key reference;
the `key_id` column pattern from ADR 006 would be the template.

### A2-723 — DB pool × instances may exceed Fly Postgres limit (Medium, deferred probe)

**Files:** `apps/backend/src/db/client.ts:19-32`; `fly.toml`
(autoscale) — out of scope here.
**Remediation:** set `DATABASE_POOL_MAX` explicitly in prod env;
cross-check instance cap × pool vs Fly Postgres `max_connections`
during Phase 16 / 17.

### A2-724 — No `statement_timeout` on the DB session (Medium)

**File:** `apps/backend/src/db/client.ts` has no `SET LOCAL` or
per-session timeout. A runaway admin aggregate monopolises a pool
connection.
**Remediation:** `postgres(..., { connection: { statement_timeout: '10s' } })`
as a baseline, overridden per long-running admin handler.

### A2-725 — Client abort does not cancel in-flight DB queries (Medium)

**File:** every admin handler; no AbortSignal plumbing into drizzle.
**Impact:** user closes the dashboard tab, the 30s merchant-stats
query continues to run to completion.
**Remediation:** forward `c.req.raw.signal` into the `postgres-js`
query's abort path; drizzle's drivers accept a `signal` option.

---

## Deferred probes (no prod / live-DB access)

- `pg_stat_user_indexes` for actual usage (G4-05 never-hit indexes)
- `pg_stat_statements` for slow-query profile
- Fly Postgres `max_connections` cross-check (G5-29)
- Autovacuum tuning (G5-31)
- Read replica presence (G5-32)
- Backup/restore rehearsal — deferred to Phase 17 per plan
