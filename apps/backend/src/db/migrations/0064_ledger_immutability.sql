-- FT-13 (money / data-integrity) — DB-tier immutability for the
-- financial ledger.
--
-- `credit_transactions` is the append-only LEDGER: every user-visible
-- balance delta is one immutable row (docs on the drizzle table call
-- it "append-only ledger"; ADR 017 #4 promises "why is reconstructable
-- from the append-only ledger"). But "append-only" was app-CONVENTION
-- only — nothing in the database stopped a rogue or buggy `UPDATE` /
-- `DELETE` from rewriting or erasing a booked money row. Re-derived
-- from the code: there is NO writer path anywhere (product code OR the
-- integration suite) that UPDATEs or DELETEs a `credit_transactions`
-- row — corrections are always a NEW offsetting row (refund / spend /
-- adjustment insert), and there is no `onConflictDoUpdate` on the
-- table. So the ledger is truly immutable-once-written, and this
-- migration fences that at the database boundary: no writer — present
-- or future, app or manual SQL — can mutate a booked ledger row.
--
-- `user_credits` is DIFFERENT: it is the mutable running-balance
-- projection — `balance_minor` is legitimately UPDATEd on every
-- transaction (orders/transitions, refunds, adjustments, interest
-- accrual, vault redemptions, payout compensation all `UPDATE
-- user_credits`). We must NOT block those updates. What no code path
-- ever does is DELETE a `user_credits` row — deleting a user's balance
-- row out from under the ledger would orphan every `credit_transactions`
-- row for that (user, currency) and silently drop a live liability. So
-- `user_credits` gets a DELETE-guard only; its UPDATE path is untouched.
--
-- Mechanism (mirrors the 0044 emission-conservation trigger idiom):
-- BEFORE row-level triggers that RAISE EXCEPTION, so the forbidden
-- statement aborts its transaction. Row-level UPDATE/DELETE triggers do
-- NOT fire on TRUNCATE, so the integration suite's per-test
-- `TRUNCATE ... CASCADE` reset is unaffected.
--
-- ERRCODE 'restrict_violation' (SQLSTATE 23001): the operation is
-- restricted, semantically distinct from a data-validation
-- 'check_violation' so a future error handler can never mistake a
-- ledger-immutability abort for a bad-value CHECK failure. No app code
-- catches it because no app code ever attempts the write — it only ever
-- fires on a rogue/buggy mutation, which should hard-abort.
--
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- Rollback:
--   DROP TRIGGER credit_transactions_immutable ON credit_transactions;
--   DROP FUNCTION reject_credit_transactions_mutation();
--   DROP TRIGGER user_credits_no_delete ON user_credits;
--   DROP FUNCTION reject_user_credits_delete();

CREATE OR REPLACE FUNCTION reject_credit_transactions_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_transactions is an append-only ledger — % on a booked ledger row (id %) is forbidden; corrections must be a new offsetting row, never a mutation',
    TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_transactions_immutable ON credit_transactions;
--> statement-breakpoint
CREATE TRIGGER credit_transactions_immutable
  BEFORE UPDATE OR DELETE ON credit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION reject_credit_transactions_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_user_credits_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'user_credits is the ledger balance projection — deleting the balance row for user % (%) would orphan its credit_transactions and drop a live liability; DELETE is forbidden (balance UPDATE is allowed)',
    OLD.user_id, OLD.currency
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_credits_no_delete ON user_credits;
--> statement-breakpoint
CREATE TRIGGER user_credits_no_delete
  BEFORE DELETE ON user_credits
  FOR EACH ROW
  EXECUTE FUNCTION reject_user_credits_delete();
