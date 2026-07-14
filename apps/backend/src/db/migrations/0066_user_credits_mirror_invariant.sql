-- DAT-01-inv1 (money / data-integrity) — DB-tier enforcement of the
-- balance/ledger MIRROR invariant (INV-1).
--
-- ADR 009 declares the running-balance projection is a MATERIALISED sum
-- of the immutable ledger: for each `(user_id, currency)`,
--   user_credits.balance_minor == COALESCE(
--     SUM(credit_transactions.amount_minor) for that user+currency, 0).
-- credits/ledger-invariant.ts (`computeLedgerDriftSql`) states the same
-- equality, and the admin reconciliation endpoint / drift watcher READ
-- it — but nothing WROTE it as a constraint. It was app-CONVENTION only:
-- every legitimate credit operation happens to update the balance and
-- append a matching ledger row in one transaction, but a buggy or future
-- writer that moves ONE side without the other (balance UPDATE with no
-- ledger row, or a ledger INSERT with no balance UPDATE) silently breaks
-- the mirror, and the running balance diverges from the immutable ledger
-- with nothing to stop it at the DB boundary. This migration fences the
-- equality at that boundary, so no writer — present or future, app or
-- manual SQL — can COMMIT a state where a touched user's balance
-- disagrees with its ledger sum.
--
-- WHY A DEFERRED, COMMIT-TIME CONSTRAINT TRIGGER (not a per-statement
-- BEFORE trigger, as 0044/0064 use):
-- A legitimate credit operation does BOTH sides of the mirror in ONE
-- transaction — e.g. `INSERT INTO credit_transactions (+500)` THEN
-- `UPDATE user_credits SET balance_minor = balance_minor + 500`. BETWEEN
-- those two statements the mirror is transiently unequal. An immediate
-- (per-statement) check would false-trigger on that intermediate state
-- and reject every real write. So this is a
-- `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, evaluated once
-- per touched row at COMMIT, by which point a correct transaction has
-- restored equality. Intermediate imbalance inside the txn is invisible
-- to it; only the committed end-state is asserted. (Constraint triggers
-- are AFTER/ROW by definition, so these COEXIST with 0064's BEFORE
-- UPDATE/DELETE immutability trigger on credit_transactions and its
-- BEFORE DELETE guard on user_credits — different timing, different
-- events — and with 0044's triggers, which are on `pending_payouts`.)
--
-- SCOPE — the two sides of the mirror, both fired:
--   * AFTER INSERT ON credit_transactions — catches "appended a ledger
--     row without moving the balance" (balance now < ledger sum).
--   * AFTER INSERT OR UPDATE ON user_credits — catches "moved the balance
--     without a matching ledger row" (balance now <> ledger sum). INSERT
--     covers the first credit that materialises a user's balance row;
--     UPDATE covers every subsequent balance move.
-- Both triggers run the SAME function, keyed off `NEW.user_id` /
-- `NEW.currency` (columns present on both tables). At commit, for that
-- touched `(user_id, currency)` it asserts balance == COALESCE(ledger
-- sum, 0). A missing `user_credits` row is treated as balance 0 — so a
-- ledger that sums to 0 with no balance row (a zero-sum orphan) passes,
-- but a non-zero ledger with no balance row is the drift it must catch.
--
-- ERRCODE '23M01' (custom SQLSTATE): class 23 is Integrity Constraint
-- Violation — semantically exactly a mirror/aggregate-consistency
-- breach. The 'M01' subclass ('M' for Mirror, invariant #1) is NOT a
-- code PostgreSQL allocates (its own non-standard additions live in the
-- 'P' subclass, e.g. 23P01) and is deliberately DISTINCT from FT-13's
-- restrict_violation (23001, migration 0064) and 0044/0061's
-- check_violation (23514), so an error handler can never confuse a
-- balance/ledger divergence with a ledger-immutability abort or a
-- bad-value CHECK. No app code catches it — it only ever fires on a
-- writer that broke the mirror, which should hard-abort the transaction.
--
-- PERFORMANCE: the commit-time check runs one
-- `SUM(amount_minor) WHERE user_id = ? AND currency = ?` per touched
-- (user, currency) row. The new `credit_transactions_user_currency`
-- btree below serves that predicate as a bounded range scan over exactly
-- the summed rows (the pre-existing `(user_id, created_at)` index only
-- prefixes on user_id, so it reads every currency's rows for the user).
-- Cost is still O(rows for that user+currency) per write; for a user with
-- a very large ledger this is the trade the invariant costs. See
-- residual_risk.
--
-- PRE-EXISTING DRIFT: a CONSTRAINT TRIGGER fires only for rows a
-- transaction TOUCHES, so this migration does NOT retroactively validate
-- untouched historical rows — applying it is a pure DDL no-op against
-- existing data. But if a user's balance ALREADY drifted before this
-- migration, the NEXT legitimate write touching that user would fail the
-- commit-time check against the corrected sum. Enabling this in prod
-- therefore REQUIRES a prior reconciliation/backfill sweep
-- (`scripts/check-ledger-invariant.ts` / the admin reconciliation
-- endpoint must report zero drift) as a deploy prerequisite. That runtime
-- step is separate from this migration.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS +
-- CREATE INDEX IF NOT EXISTS.
-- Rollback:
--   DROP TRIGGER credit_transactions_mirror_invariant ON credit_transactions;
--   DROP TRIGGER user_credits_mirror_invariant ON user_credits;
--   DROP FUNCTION assert_user_credits_mirror();
--   DROP INDEX credit_transactions_user_currency;

CREATE INDEX IF NOT EXISTS credit_transactions_user_currency
  ON credit_transactions (user_id, currency);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_user_credits_mirror() RETURNS trigger AS $$
DECLARE
  ledger_sum bigint;
  balance_val bigint;
BEGIN
  -- Authoritative ledger sum for the touched (user, currency). At commit
  -- this sees this transaction's own committed-in-progress ledger inserts
  -- plus every prior committed row (READ COMMITTED snapshot per stmt).
  SELECT COALESCE(SUM(ct.amount_minor), 0) INTO ledger_sum
  FROM credit_transactions ct
  WHERE ct.user_id = NEW.user_id AND ct.currency = NEW.currency;

  -- Materialised balance for the same key; a missing row means the mirror
  -- claims 0 (so a zero-sum ledger with no balance row still balances).
  SELECT uc.balance_minor INTO balance_val
  FROM user_credits uc
  WHERE uc.user_id = NEW.user_id AND uc.currency = NEW.currency;
  IF NOT FOUND THEN
    balance_val := 0;
  END IF;

  IF balance_val <> ledger_sum THEN
    RAISE EXCEPTION 'user_credits mirror invariant (INV-1) violated for user % (%): balance_minor % <> ledger SUM(amount_minor) % — a balance write must be matched by a ledger row (and vice-versa) within the same transaction',
      NEW.user_id, NEW.currency, balance_val, ledger_sum
      USING ERRCODE = '23M01';
  END IF;

  -- AFTER ... FOR EACH ROW trigger: return value is ignored.
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_transactions_mirror_invariant ON credit_transactions;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER credit_transactions_mirror_invariant
  AFTER INSERT ON credit_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_user_credits_mirror();
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_credits_mirror_invariant ON user_credits;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER user_credits_mirror_invariant
  AFTER INSERT OR UPDATE ON user_credits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_user_credits_mirror();
