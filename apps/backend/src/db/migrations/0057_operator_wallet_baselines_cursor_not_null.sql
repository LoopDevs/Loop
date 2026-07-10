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
-- Any pre-existing baseline missing a cursor (active OR inactive) is
-- DELETED — not backfilled (there is no correct cursor value to invent
-- for a row that never recorded one) and not merely deactivated. A
-- deactivate (`SET active = 0`) would leave the NULL in the column, and
-- `ALTER COLUMN ... SET NOT NULL` below scans the literal value of
-- EVERY row regardless of the active flag — so a lingering NULL (active
-- or already-inactive) would abort the whole migration and block the
-- deploy in exactly the scenario this defense exists for (a staging
-- raw-SQL row, a DR restore predating the Zod hardening, a future
-- non-API writer). The DELETE clears the NULL that blocks the ALTER,
-- and such a row can never be reconciled anyway — so its fail-closed
-- successor is the reconciler's existing `needs_baseline` state for
-- that (account, asset) once an operator creates a fresh, anchored
-- baseline. As of this migration no production baseline has been
-- created yet (R3-1 baseline creation is an operator step that lands
-- after this migration), so this is expected to be a no-op in practice.
DELETE FROM operator_wallet_baselines
  WHERE starting_horizon_cursor IS NULL OR current_horizon_cursor IS NULL;

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
