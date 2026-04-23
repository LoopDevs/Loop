-- A2-908: admin-originated ledger writes accept a `reason` parameter
-- but persist it only in `admin_idempotency_keys.response_body` and
-- the Discord audit embed. The idempotency key has a 24-hour TTL
-- sweep (A2-721) — after that window the reason is unrecoverable.
-- ADR 017 #4 claims "the full story — who did it, why, what was the
-- prior and new balance — is reconstructable from the append-only
-- ledger without an edit log." Without a `reason` column the
-- "why" is lost beyond 24h.
--
-- Nullable because cashback / interest / spend rows have no operator-
-- authored reason — those types are machine-generated. The admin
-- writers (adjustment, refund) populate it; the schema doesn't force
-- the distinction because adding a (type, reason_presence) CHECK
-- would foreclose future admin-originated types we haven't shipped
-- yet.

ALTER TABLE credit_transactions
  ADD COLUMN reason TEXT;
