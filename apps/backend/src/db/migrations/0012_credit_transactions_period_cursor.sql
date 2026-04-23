-- ADR 009 / audit A2-906: interest accrual needs period-level idempotency.
-- Previously `accrueOnePeriod` had no way to know it had already run for a
-- given period — a double-tick (scheduler retry after a transient failure,
-- or a concurrent invocation) would double-credit every user. The fix:
--
--   1. Add a nullable `period_cursor` column to `credit_transactions`.
--   2. Enforce that it's populated iff `type = 'interest'` (every other
--      transaction type carries context via `reference_type` + `reference_id`;
--      interest is the only type that's period-keyed).
--   3. Add a partial unique index on (user_id, currency, period_cursor)
--      scoped to `type = 'interest'`. A re-run with the same cursor fails
--      the insert at the DB layer rather than silently double-crediting.
--
-- Combined with the `FOR UPDATE` discipline in the application code
-- (A2-611 / A2-700) and the `currency` predicate on the balance UPDATE
-- (A2-610), this closes the accrue-interest cluster.

ALTER TABLE credit_transactions
  ADD COLUMN period_cursor TEXT;

ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_period_cursor_interest_only
  CHECK ((type = 'interest') = (period_cursor IS NOT NULL));

CREATE UNIQUE INDEX credit_transactions_interest_period_unique
  ON credit_transactions (user_id, currency, period_cursor)
  WHERE type = 'interest';
