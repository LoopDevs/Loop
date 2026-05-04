-- A4-028: pin the ADR-017 reason length contract at the DB layer.
--
-- App-side handlers validate `2..500` characters; a direct INSERT
-- (admin shell, future writer that drifts from the handler
-- validators) could land an empty string or a multi-megabyte blob.
-- The CHECK is NULL-tolerant: many ledger rows (cashback / spend /
-- interest) legitimately leave `reason` NULL, so the constraint
-- only kicks in when reason is supplied.
--
-- Idempotent: DROP IF EXISTS keeps a partial-apply rerun safe.

ALTER TABLE credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_reason_length;

ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_reason_length
  CHECK (reason IS NULL OR (length(reason) >= 2 AND length(reason) <= 500));
