-- R3-1: operator XLM/USDC float reconciliation.
--
-- This is a historical conservation ledger for the operator/deposit
-- wallet, not a point-in-time balance card. Ops must create a
-- baseline for each (account, asset); absence of a baseline is a
-- fail-closed `needs_baseline` reconciliation state.

CREATE TABLE IF NOT EXISTS operator_wallet_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset text NOT NULL,
  account text NOT NULL,
  opening_balance_stroops bigint NOT NULL,
  starting_horizon_cursor text,
  current_horizon_cursor text,
  active integer NOT NULL DEFAULT 1,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_wallet_baselines_asset_known CHECK (asset IN ('xlm', 'usdc')),
  CONSTRAINT operator_wallet_baselines_opening_non_negative CHECK (opening_balance_stroops >= 0),
  CONSTRAINT operator_wallet_baselines_active_bool CHECK (active IN (0, 1)),
  CONSTRAINT operator_wallet_baselines_reason_len CHECK (length(reason) BETWEEN 2 AND 500),
  CONSTRAINT operator_wallet_baselines_created_by_len CHECK (length(created_by) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS operator_wallet_baselines_account_asset_active
  ON operator_wallet_baselines (account, asset, active);

CREATE TABLE IF NOT EXISTS operator_manual_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset text NOT NULL,
  account text NOT NULL,
  direction text NOT NULL,
  amount_stroops bigint NOT NULL,
  movement_payment_id text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_manual_movements_asset_known CHECK (asset IN ('xlm', 'usdc')),
  CONSTRAINT operator_manual_movements_direction_known CHECK (direction IN ('in', 'out')),
  CONSTRAINT operator_manual_movements_amount_positive CHECK (amount_stroops > 0),
  CONSTRAINT operator_manual_movements_reason_len CHECK (length(reason) BETWEEN 2 AND 500),
  CONSTRAINT operator_manual_movements_created_by_len CHECK (length(created_by) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS operator_manual_movements_account_asset_effective
  ON operator_manual_movements (account, asset, effective_at);
CREATE INDEX IF NOT EXISTS operator_manual_movements_payment
  ON operator_manual_movements (movement_payment_id);

CREATE TABLE IF NOT EXISTS operator_wallet_movements (
  payment_id text PRIMARY KEY,
  tx_hash text NOT NULL,
  paging_token text NOT NULL,
  account text NOT NULL,
  asset text NOT NULL,
  asset_code text NOT NULL,
  asset_issuer text,
  direction text NOT NULL,
  from_address text,
  to_address text,
  memo_text text,
  amount_stroops bigint NOT NULL,
  classification text NOT NULL DEFAULT 'unclassified',
  order_id uuid,
  refund_payment_id text,
  settlement_id uuid,
  manual_movement_id uuid,
  raw_payment jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_wallet_movements_order_id_orders_id_fk
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT operator_wallet_movements_refund_payment_id_payment_watcher_skips_payment_id_fk
    FOREIGN KEY (refund_payment_id) REFERENCES payment_watcher_skips(payment_id) ON DELETE SET NULL,
  CONSTRAINT operator_wallet_movements_settlement_id_ctx_settlements_id_fk
    FOREIGN KEY (settlement_id) REFERENCES ctx_settlements(id) ON DELETE SET NULL,
  CONSTRAINT operator_wallet_movements_manual_movement_id_operator_manual_movements_id_fk
    FOREIGN KEY (manual_movement_id) REFERENCES operator_manual_movements(id) ON DELETE SET NULL,
  CONSTRAINT operator_wallet_movements_asset_known CHECK (asset IN ('xlm', 'usdc')),
  CONSTRAINT operator_wallet_movements_direction_known CHECK (direction IN ('in', 'out')),
  CONSTRAINT operator_wallet_movements_amount_positive CHECK (amount_stroops > 0),
  CONSTRAINT operator_wallet_movements_classification_known
    CHECK (classification IN ('user_deposit', 'ctx_settlement', 'deposit_refund', 'manual', 'unclassified'))
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_wallet_movements_paging_unique
  ON operator_wallet_movements (paging_token);
CREATE INDEX IF NOT EXISTS operator_wallet_movements_account_asset_observed
  ON operator_wallet_movements (account, asset, observed_at);
CREATE INDEX IF NOT EXISTS operator_wallet_movements_classification
  ON operator_wallet_movements (classification, observed_at);
CREATE INDEX IF NOT EXISTS operator_wallet_movements_tx_hash
  ON operator_wallet_movements (tx_hash);

CREATE TABLE IF NOT EXISTS operator_float_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset text NOT NULL,
  account text NOT NULL,
  baseline_id uuid,
  expected_balance_stroops bigint,
  actual_balance_stroops bigint,
  delta_stroops bigint,
  threshold_stroops bigint NOT NULL,
  unclassified_count integer NOT NULL DEFAULT 0,
  indexed_movement_count integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  error text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_float_reconciliation_runs_baseline_id_operator_wallet_
    FOREIGN KEY (baseline_id) REFERENCES operator_wallet_baselines(id) ON DELETE SET NULL,
  CONSTRAINT operator_float_runs_asset_known CHECK (asset IN ('xlm', 'usdc')),
  CONSTRAINT operator_float_runs_state_known
    CHECK (state IN ('ok', 'drift', 'unclassified', 'needs_baseline', 'error')),
  CONSTRAINT operator_float_runs_threshold_non_negative CHECK (threshold_stroops >= 0),
  CONSTRAINT operator_float_runs_unclassified_non_negative CHECK (unclassified_count >= 0)
);

CREATE INDEX IF NOT EXISTS operator_float_runs_account_asset_checked
  ON operator_float_reconciliation_runs (account, asset, checked_at);
