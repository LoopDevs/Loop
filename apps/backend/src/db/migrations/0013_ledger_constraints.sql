-- Batch 2B: ledger constraints (A2-614 + A2-902 + A2-903).
--
-- A2-903 — `user_credits.currency` accepted any string, so a typo or an
-- attacker-supplied 'ZZZ' would land a zombie balance row the admin UI can
-- never display (FX rates only defined for USD/GBP/EUR per ADR 015). Lock
-- the column to the three ISO-4217 codes we actually support; adding a
-- fourth currency will be a deliberate migration, not silent drift.
--
-- A2-614 + A2-902 — `credit_transactions` has no uniqueness on
-- (type, reference_type, reference_id) for writer types that are supposed
-- to be at-most-once. Two CTX webhook retries landing the same cashback
-- payload would insert TWO rows; a duplicate refund for the same order
-- would double-credit. The partial unique index is scoped to the writer
-- types where at-most-once is the contract:
--   - 'cashback' with (reference_type='order', reference_id=<order id>)
--   - 'refund'   with (reference_type='order', reference_id=<order id>)
--   - 'spend'    already at-most-once via the order state machine; the
--     createOrder txn inserts exactly one spend row per order (A2-601).
--
-- 'adjustment' is NOT in the scope — admin adjustments are intentionally
-- repeatable (an operator may issue multiple adjustments per order for
-- ops reasons). Idempotency for adjustments lives one layer up in
-- admin_idempotency_keys (ADR 017).
--
-- 'interest' is NOT in the scope either — it has its own partial unique
-- index on (user_id, currency, period_cursor) from migration 0012.
--
-- 'withdrawal' — no writer exists yet (Phase 2). When it lands the
-- uniqueness should be scoped to the payout id, so this migration leaves
-- it out.

ALTER TABLE user_credits
  ADD CONSTRAINT user_credits_currency_known
  CHECK (currency IN ('USD', 'GBP', 'EUR'));

CREATE UNIQUE INDEX credit_transactions_reference_unique
  ON credit_transactions (type, reference_type, reference_id)
  WHERE type IN ('cashback', 'refund', 'spend')
    AND reference_type IS NOT NULL
    AND reference_id IS NOT NULL;
