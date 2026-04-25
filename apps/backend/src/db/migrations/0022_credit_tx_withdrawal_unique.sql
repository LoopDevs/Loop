-- A2-901 / ADR-024 §4: extend `credit_transactions_reference_unique`
-- to include `type='withdrawal'` so the at-most-once invariant matches
-- the cashback/refund/spend writers.
--
-- Migration 0013 added the partial unique index but deliberately
-- scoped it to ('cashback', 'refund', 'spend') because the
-- withdrawal writer didn't exist yet. The note in 0013 said:
--
--   'withdrawal' — no writer exists yet (Phase 2). When it lands the
--   uniqueness should be scoped to the payout id, so this migration
--   leaves it out.
--
-- The withdrawal writer (`applyAdminWithdrawal` in the next PR)
-- writes a `type='withdrawal'` credit-tx referencing the
-- `pending_payouts.id` it just inserted. Each pending_payouts.id
-- is fresh per call (UUID v4 default), so naturally-occurring
-- "same payout twice" is not the concern — the partial unique
-- index exists to catch operator-error retries that bypass the
-- ADR-017 idempotency layer (concurrent admins issuing parallel
-- withdrawals for the same already-issued payout id).
--
-- Drop + recreate is the standard pattern for partial-index scope
-- changes; Postgres has no `ALTER INDEX ... ADD CONDITION`. The
-- recreate runs inside the migration's implicit transaction so a
-- crash between drop and create can't leave the table without the
-- guard.

DROP INDEX IF EXISTS credit_transactions_reference_unique;

CREATE UNIQUE INDEX credit_transactions_reference_unique
  ON credit_transactions (type, reference_type, reference_id)
  WHERE type IN ('cashback', 'refund', 'spend', 'withdrawal')
    AND reference_type IS NOT NULL
    AND reference_id IS NOT NULL;
