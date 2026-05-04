-- A4-024: extend `record_merchant_cashback_config_history` so an
-- INSERT or DELETE of a `merchant_cashback_configs` row also lands
-- a history entry. The original trigger fired only on UPDATE
-- (BEFORE UPDATE FOR EACH ROW), so:
--
--   * a first-time INSERT of a merchant cashback config had no
--     history footprint until a later UPDATE happened;
--   * a DELETE (e.g. an admin DB shell removing a row) vanished
--     entirely from the audit trail.
--
-- ADR-011 + the schema docstring on `merchant_cashback_config_history`
-- imply complete coverage. This migration restores the invariant
-- by adding AFTER INSERT + AFTER DELETE triggers that share the
-- same INSERT-into-history function.
--
-- Implementation notes:
--   - INSERT and DELETE triggers use NEW / OLD respectively to
--     pull the row values, so the function needs to handle both
--     cases via `TG_OP`. Earlier the function read OLD only
--     because it was UPDATE-only; we extend it to read NEW for
--     INSERTs (history captures the values that just landed) and
--     OLD for DELETEs (the values being removed).
--   - `changed_by` defaults to the row's `updated_by` for INSERT
--     and DELETE, which is the operator who last touched the row
--     before the deletion — same shape as UPDATE.
--   - Wrapped in DROP IF EXISTS / CREATE so this migration is
--     idempotent on a partially-applied DB (matches the discipline
--     in 0016).

CREATE OR REPLACE FUNCTION record_merchant_cashback_config_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO merchant_cashback_config_history (
      merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct,
      active, changed_by, changed_at
    ) VALUES (
      OLD.merchant_id, OLD.wholesale_pct, OLD.user_cashback_pct, OLD.loop_margin_pct,
      OLD.active, OLD.updated_by, OLD.updated_at
    );
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO merchant_cashback_config_history (
      merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct,
      active, changed_by, changed_at
    ) VALUES (
      NEW.merchant_id, NEW.wholesale_pct, NEW.user_cashback_pct, NEW.loop_margin_pct,
      NEW.active, NEW.updated_by, NEW.updated_at
    );
    RETURN NEW;
  ELSE
    -- UPDATE: preserve original behaviour — capture the prior
    -- values so a "what did this look like before this change"
    -- query reads naturally (changed_at = OLD.updated_at).
    INSERT INTO merchant_cashback_config_history (
      merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct,
      active, changed_by, changed_at
    ) VALUES (
      OLD.merchant_id, OLD.wholesale_pct, OLD.user_cashback_pct, OLD.loop_margin_pct,
      OLD.active, OLD.updated_by, OLD.updated_at
    );
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate so the migration is idempotent and so we
-- pick up the new function body for the existing UPDATE trigger.
DROP TRIGGER IF EXISTS merchant_cashback_configs_audit ON merchant_cashback_configs;
DROP TRIGGER IF EXISTS merchant_cashback_configs_audit_insert ON merchant_cashback_configs;
DROP TRIGGER IF EXISTS merchant_cashback_configs_audit_delete ON merchant_cashback_configs;

CREATE TRIGGER merchant_cashback_configs_audit
  BEFORE UPDATE ON merchant_cashback_configs
  FOR EACH ROW EXECUTE FUNCTION record_merchant_cashback_config_history();

CREATE TRIGGER merchant_cashback_configs_audit_insert
  AFTER INSERT ON merchant_cashback_configs
  FOR EACH ROW EXECUTE FUNCTION record_merchant_cashback_config_history();

CREATE TRIGGER merchant_cashback_configs_audit_delete
  AFTER DELETE ON merchant_cashback_configs
  FOR EACH ROW EXECUTE FUNCTION record_merchant_cashback_config_history();
