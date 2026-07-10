-- R3-1 production readiness: cold-start cursor safety.
--
-- `starting_horizon_cursor` was nullable in the DB even though the
-- baseline-create API (POST /api/admin/operator-float/baselines) has
-- required it as a non-empty string since the 2026-07-08 money
-- review — a Zod-only, app-layer "convention" tier check. A baseline
-- with a null cursor makes the reconciler's indexer
-- (`payments/operator-float-reconciliation.ts`) omit Horizon's
-- `cursor` query param entirely, which walks the account's ENTIRE
-- payment history from genesis instead of starting at the baseline's
-- chosen anchor point — an unbounded cold-start re-scan that also
-- double-counts every pre-baseline movement against the opening
-- balance. This promotes the guard to the DB tier, matching the
-- convention->DB-constraint pattern used throughout the 2026-07
-- hardening pass.
--
-- Any pre-existing ACTIVE baseline missing a cursor is deactivated
-- (not backfilled — there is no correct cursor value to invent for a
-- row that never recorded one) so it can't block this migration and
-- so the reconciler falls back to its existing fail-closed
-- `needs_baseline` state for that (account, asset) instead of being
-- left active with an unusable cursor. As of this migration no
-- production baseline has been created yet (R3-1 baseline creation is
-- an operator step that lands after this migration), so this is
-- expected to be a no-op in practice.
UPDATE operator_wallet_baselines
  SET active = 0, updated_at = now()
  WHERE (starting_horizon_cursor IS NULL OR current_horizon_cursor IS NULL)
    AND active = 1;

ALTER TABLE operator_wallet_baselines
  ALTER COLUMN starting_horizon_cursor SET NOT NULL;

ALTER TABLE operator_wallet_baselines
  ALTER COLUMN current_horizon_cursor SET NOT NULL;

ALTER TABLE operator_wallet_baselines
  ADD CONSTRAINT operator_wallet_baselines_starting_cursor_len
  CHECK (length(starting_horizon_cursor) >= 1);

ALTER TABLE operator_wallet_baselines
  ADD CONSTRAINT operator_wallet_baselines_current_cursor_len
  CHECK (length(current_horizon_cursor) >= 1);
