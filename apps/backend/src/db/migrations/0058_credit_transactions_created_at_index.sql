-- A5-8: fleet-wide admin ledger browser (GET /api/admin/ledger).
--
-- Mirrors PERF-005 (migration 0036, orders_created_at): the existing
-- credit_transactions indexes are both composite with a leading
-- column that isn't created_at — (user_id, created_at) and
-- (type, created_at) — so neither serves an unfiltered (or
-- date-range-only) `ORDER BY created_at DESC LIMIT n` fleet browse.
-- Without this index that query would seq-scan + sort the whole
-- table, and it only gets worse as the ledger grows (~1 row/user/
-- night from interest-mint alone). A plain btree on created_at lets
-- Postgres serve the unfiltered/date-range browse as a bounded
-- backward index scan capped by LIMIT — the S4-6 lesson (keep admin
-- ledger reads bounded + indexed, never an unbounded scan that can
-- monopolize a DB connection) applied to a new read path instead of
-- an existing one.
--
-- `CREATE INDEX IF NOT EXISTS` so a re-run on a partially-migrated DB
-- is idempotent, matching migration 0036's convention. Matching
-- declaration added to src/db/schema/credits.ts so
-- check:migration-parity stays green.

CREATE INDEX IF NOT EXISTS credit_transactions_created_at
  ON credit_transactions (created_at);
