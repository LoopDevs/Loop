-- ADR 009 / ADR 011: free-text note on the credit ledger, populated
-- by support / admin credit-adjustment writes so a later reviewer can
-- understand *why* a manual debit or credit was booked. Nullable —
-- every existing row (cashback / interest / refund / spend / withdrawal)
-- derives its context from `reference_type` + `reference_id` and has
-- no note. `adjustment` is where this field earns its keep.
ALTER TABLE "credit_transactions"
  ADD COLUMN "note" text;
