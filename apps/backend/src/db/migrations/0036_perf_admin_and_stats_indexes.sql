-- CF-29 / x-perf PERF-001 + PERF-005 + PERF-006 + PERF-007: indexes for
-- the hot admin time-series / treasury views, the public cashback-stats
-- aggregate, and the remaining admin-filter / drift-watcher gaps that
-- degrade as the ledger / order / payout tables grow.
--
-- All `CREATE INDEX IF NOT EXISTS` so a re-run on a partially-migrated
-- DB is idempotent (cross-ref `migration-rollback.md` §"Idempotency-
-- violating SQL"). Every index below has a matching declaration in
-- src/db/schema.ts so `check:migration-parity` stays green.
--
-- ── PERF-005 (P1): plain btree on created_at ─────────────────────────
-- `orders` and `credit_transactions` only had composite
-- `(user_id, created_at)` indexes whose leading column doesn't help an
-- unfiltered range. `orders-activity` (default dashboard sparkline) and
-- `treasury` / `cashback-realization` aggregate over the full table; the
-- most-opened admin views seq-scan the two largest growing tables.
--
-- `credit_transactions_type_created` (type, created_at) doubles as the
-- supporting index for PERF-001's public cashback-stats roll-up
-- (`WHERE type='cashback'` + the per-currency SUM) — the leading `type`
-- column lets the planner skip straight to the cashback partition.

CREATE INDEX IF NOT EXISTS orders_created_at
  ON orders (created_at);

CREATE INDEX IF NOT EXISTS credit_transactions_type_created
  ON credit_transactions (type, created_at);

-- ── PERF-006 (P2): admin filter / aggregate covering indexes ─────────
--
-- operator-stats / operators-snapshot-csv filter
-- `ctx_operator_id IS NOT NULL AND created_at >= since`; the existing
-- single-column `orders_ctx_operator` can't serve the range. Composite
-- (ctx_operator_id, created_at) covers the operator-scoped time window.

CREATE INDEX IF NOT EXISTS orders_ctx_operator_created
  ON orders (ctx_operator_id, created_at);

-- payouts-by-asset does `GROUP BY asset_code, state` over the full
-- pending_payouts table with no asset_code index. (INCLUDE
-- (amount_stroops) from the audit fix is omitted — drizzle 0.45's index
-- DSL can't represent INCLUDE, and the parity gate would flag the drift;
-- the composite still serves the grouped scan.)

CREATE INDEX IF NOT EXISTS pending_payouts_asset_state
  ON pending_payouts (asset_code, state);

-- settlement-lag / payouts-activity / payouts-activity-csv filter
-- `state='confirmed' AND confirmed_at >= since`; no confirmed_at index
-- existed. Partial scoped to confirmed rows keeps it small.

CREATE INDEX IF NOT EXISTS pending_payouts_confirmed_at
  ON pending_payouts (confirmed_at)
  WHERE state = 'confirmed';

-- users-recycling-activity / -csv filter
-- `payment_method='loop_asset' AND created_at >= 90d`; no index on
-- either column served it. Partial scoped to loop_asset orders.

CREATE INDEX IF NOT EXISTS orders_loop_asset_created
  ON orders (created_at)
  WHERE payment_method = 'loop_asset';

-- stuck-orders polls `state IN ('paid','procuring')`; `procuring` has a
-- partial (orders_procuring_procured_at) but `paid` has no supporting
-- index. Partial covering both in-flight states.

CREATE INDEX IF NOT EXISTS orders_paid_procuring_created
  ON orders (created_at)
  WHERE state IN ('paid', 'procuring');

-- user-by-email resolves ctx-backed users via `LOWER(email) = x`; the
-- only functional index on LOWER(email) is partial `WHERE ctx_user_id
-- IS NULL` (Loop-native rows). A non-partial functional index serves
-- the equality lookup for every user regardless of identity plane.
-- (pg_trgm GIN for the `LIKE '%q%'` substring search is intentionally
-- deferred — it needs the pg_trgm extension and is only worth it if the
-- admin email-substring search becomes hot; x-perf flags it "if".)

CREATE INDEX IF NOT EXISTS users_email_lower
  ON users (LOWER(email));

-- ── PERF-007 (P2): drift-watcher per-currency liability sum ──────────
-- `sumOutstandingLiability(currency)` does `SUM(balance_minor) WHERE
-- currency = X`. user_credits PK is (user_id, currency) — leading
-- column user_id, so a bare currency predicate can't use it → seq scan.
-- Called once per LOOP asset (3) per drift tick (every 300s).

CREATE INDEX IF NOT EXISTS user_credits_currency
  ON user_credits (currency);
