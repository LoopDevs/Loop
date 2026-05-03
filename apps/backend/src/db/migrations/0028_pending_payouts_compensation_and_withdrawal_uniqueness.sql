-- A3-006 / A3-007: fix the two payout-side at-most-once gaps.
--
-- 1. `compensated_at` records that a failed withdrawal payout was
--    already made whole off-chain, without widening the shared payout
--    state enum to a fifth value. Admin retry now refuses rows where
--    `compensated_at IS NOT NULL`.
-- 2. `pending_payouts_active_withdrawal_unique` enforces semantic
--    uniqueness for active withdrawal intents. The old
--    `credit_transactions_reference_unique` guard only applied after
--    a fresh payout UUID already existed, so a second request with the
--    same user/asset/address/amount could still create a duplicate
--    active withdrawal.

ALTER TABLE pending_payouts
  ADD COLUMN compensated_at timestamptz;

CREATE UNIQUE INDEX pending_payouts_active_withdrawal_unique
  ON pending_payouts (user_id, asset_code, asset_issuer, to_address, amount_stroops)
  WHERE kind = 'withdrawal'
    AND state IN ('pending', 'submitted', 'failed')
    AND compensated_at IS NULL;
