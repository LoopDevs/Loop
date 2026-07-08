-- R3-1 baseline integrity (money review 2026-07-08): exactly one
-- ACTIVE baseline per (account, asset), enforced at the DB layer.
--
-- The baseline-create handler deactivates prior actives then inserts,
-- but two concurrent creates (distinct idempotency keys) could
-- interleave under READ COMMITTED and leave two active rows — and
-- `loadActiveBaseline` would then reconcile against whichever sorted
-- first by created_at. With this index the loser fails loudly with a
-- unique violation instead of silently corrupting the invariant.
CREATE UNIQUE INDEX IF NOT EXISTS operator_wallet_baselines_one_active
  ON operator_wallet_baselines (account, asset)
  WHERE active = 1;
