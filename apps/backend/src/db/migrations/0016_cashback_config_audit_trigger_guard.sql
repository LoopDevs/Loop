-- A2-703: drizzle-kit doesn't model triggers, so an accidental
-- `drizzle-kit push` or a hand-edited migration could drop the
-- `record_merchant_cashback_config_history` function + the
-- `merchant_cashback_configs_audit` trigger — silently breaking the
-- ADR-011 audit trail. This migration re-asserts both idempotently
-- so any deploy heals the trigger if a prior drop happened.
--
-- CREATE OR REPLACE FUNCTION is idempotent on its own. The trigger
-- definition isn't — there's no CREATE OR REPLACE TRIGGER in
-- standard Postgres — so we DROP IF EXISTS first, then CREATE.
-- Both are wrapped in a single migration so a failing CREATE
-- leaves the trigger intact via the implicit transaction rollback.

CREATE OR REPLACE FUNCTION record_merchant_cashback_config_history() RETURNS trigger AS $$
BEGIN
  INSERT INTO merchant_cashback_config_history (
    merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct,
    active, changed_by, changed_at
  ) VALUES (
    OLD.merchant_id, OLD.wholesale_pct, OLD.user_cashback_pct, OLD.loop_margin_pct,
    OLD.active, OLD.updated_by, OLD.updated_at
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS merchant_cashback_configs_audit ON merchant_cashback_configs;

CREATE TRIGGER merchant_cashback_configs_audit
  BEFORE UPDATE ON merchant_cashback_configs
  FOR EACH ROW EXECUTE FUNCTION record_merchant_cashback_config_history();
