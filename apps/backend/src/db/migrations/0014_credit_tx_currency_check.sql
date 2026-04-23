-- A2-704: `credit_transactions.currency` accepted any 3-char string.
-- Migration 0013 locked `user_credits.currency` down to the three ADR-015
-- denominations (USD/GBP/EUR); the parallel constraint on the ledger
-- table was missing, so a cashback/adjustment/refund insert with a typo
-- or an unsupported code like 'JPY'/'ZZZ' would land a ledger row that
-- no `user_credits` aggregation could ever reconcile against (reconcile
-- query joins on (user_id, currency) — a `JPY` ledger row has no
-- `user_credits` counterpart and would instead surface through A2-900's
-- orphan-drift path every time).
--
-- Adding the fourth currency will be a deliberate migration, not silent
-- drift. Scope matches migration 0013's `user_credits_currency_known`
-- exactly so the two constraints track together forever.

ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_currency_known
  CHECK (currency IN ('USD', 'GBP', 'EUR'));
