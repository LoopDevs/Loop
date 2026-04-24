-- A2-702: `user_credits` had a unique index on (user_id, currency)
-- but no primary key. Uniqueness was identical, but logical-
-- replication / CDC tools expect a PK for row identity, and some
-- pg_stat / pg_class queries treat PK-less tables as heap-only
-- rather than structured rows. Promoting to a composite PK is a
-- no-cost schema win.
--
-- Postgres disallows an `ADD CONSTRAINT PRIMARY KEY USING INDEX`
-- for a non-unique or non-primary index, but the existing index IS
-- unique — so we can promote it with the standard pattern:
--   1. DROP INDEX (the unique one).
--   2. ADD CONSTRAINT pkey PRIMARY KEY (cols) — Postgres builds a
--      fresh index under the hood.
-- The drop + add is wrapped in the migration's implicit transaction
-- so a crash between them doesn't leave the table without uniqueness.

DROP INDEX IF EXISTS user_credits_user_currency;

ALTER TABLE user_credits
  ADD CONSTRAINT user_credits_pkey PRIMARY KEY (user_id, currency);
