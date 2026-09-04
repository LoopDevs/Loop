-- ADR 052: collapse the three-field cashback split to a single
-- "user cashback %" — the share of Loop's CTX margin handed to the
-- customer (0 = Loop keeps the whole spread, 100 = all of it goes
-- to the customer). Wholesale/margin no longer exist Loop-side:
-- CTX owns the buy price (operator discount) and the profit share;
-- Loop's only knob is how much of its margin it gives away, pushed
-- to CTX as the link's userDiscountBasisPoints.
--
-- Hard cut, matching 0076: existing user_cashback_pct values are
-- reinterpreted under the new semantics rather than converted —
-- the pre-052 catalog had no live configs worth translating, and
-- any stale value is reconciled to CTX on the next hourly sweep.
--
-- The audit-trigger function is re-created WITHOUT the dropped
-- columns (0016/0029 pattern: CREATE OR REPLACE is idempotent; the
-- triggers themselves keep firing unchanged). The columns drop from
-- the history table too — the audit trail keeps (merchant,
-- user_cashback_pct, active, who, when), which is the part that
-- still means anything under the new model.

ALTER TABLE merchant_cashback_configs
  DROP CONSTRAINT IF EXISTS merchant_cashback_configs_sum;
ALTER TABLE merchant_cashback_configs
  DROP CONSTRAINT IF EXISTS merchant_cashback_configs_non_negative;
ALTER TABLE merchant_cashback_configs
  DROP COLUMN IF EXISTS wholesale_pct,
  DROP COLUMN IF EXISTS loop_margin_pct;
ALTER TABLE merchant_cashback_configs
  ADD CONSTRAINT merchant_cashback_configs_pct_range
  CHECK (user_cashback_pct >= 0 AND user_cashback_pct <= 100);

ALTER TABLE merchant_cashback_config_history
  DROP COLUMN IF EXISTS wholesale_pct,
  DROP COLUMN IF EXISTS loop_margin_pct;

CREATE OR REPLACE FUNCTION record_merchant_cashback_config_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO merchant_cashback_config_history (
      merchant_id, user_cashback_pct, active, changed_by, changed_at
    ) VALUES (
      OLD.merchant_id, OLD.user_cashback_pct, OLD.active, OLD.updated_by, OLD.updated_at
    );
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO merchant_cashback_config_history (
      merchant_id, user_cashback_pct, active, changed_by, changed_at
    ) VALUES (
      NEW.merchant_id, NEW.user_cashback_pct, NEW.active, NEW.updated_by, NEW.updated_at
    );
    RETURN NEW;
  ELSE
    -- UPDATE: capture the prior values so a "what did this look
    -- like before this change" query reads naturally
    -- (changed_at = OLD.updated_at).
    INSERT INTO merchant_cashback_config_history (
      merchant_id, user_cashback_pct, active, changed_by, changed_at
    ) VALUES (
      OLD.merchant_id, OLD.user_cashback_pct, OLD.active, OLD.updated_by, OLD.updated_at
    );
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;
