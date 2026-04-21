-- ADR 015: add users.home_currency. Defaulted to 'USD' so existing
-- rows backfill cleanly without an operator picking each one; any
-- non-USD user is a support-ticket correction before their first
-- Loop-native order lands. A CHECK constraint locks the column to
-- the three currencies Loop issues a LOOP-branded stablecoin for.
ALTER TABLE "users"
  ADD COLUMN "home_currency" char(3) NOT NULL DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_home_currency_known"
  CHECK ("home_currency" IN ('USD', 'GBP', 'EUR'));
