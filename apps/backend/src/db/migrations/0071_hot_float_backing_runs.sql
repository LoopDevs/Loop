-- NS-06 (migration 0071) — audit trail for
-- `treasury/hot-float-backing-reconciliation.ts`. One row per tick per
-- (network, underlying_asset_code), comparing the RECORDED hot-float
-- balance the INV-V2 solvency check trusts as backing
-- (Σ `vault_hot_float.balance_minor * 100000 + carry_stroops` across the
-- active USDC-backed vaults on the network) against the operator's ACTUAL
-- on-chain USDC held. A recorded balance that EXCEEDS the real on-chain
-- USDC beyond tolerance is a `drift`: the float is claiming solvency
-- backing that is not physically there. The complementary surplus
-- direction is EXPECTED (the operator/deposit account commingles the
-- float with user-deposit / CTX USDC) and is not recorded as drift.
--
-- Sibling of `vault_float_reconciliation_runs` (migration 0063), which
-- reconciles the operator's on-chain vault-SHARE balance; this table
-- reconciles the USDC-denominated hot-float BALANCE the shares back.
--
-- Gated end-to-end: with LOOP_VAULTS_ENABLED=false (default) the
-- reconciliation never runs and this table stays empty — this migration
-- moves no value and changes no existing behaviour.

CREATE TABLE IF NOT EXISTS "hot_float_backing_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "network" text NOT NULL,
  "underlying_asset_code" text NOT NULL,
  "account" text NOT NULL,
  "recorded_float_stroops" bigint,
  "onchain_usdc_stroops" bigint,
  "shortfall_stroops" bigint,
  "threshold_stroops" bigint NOT NULL,
  "state" text NOT NULL,
  "error" text,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hot_float_backing_runs_network_known" CHECK ("network" IN ('testnet', 'mainnet')),
  CONSTRAINT "hot_float_backing_runs_underlying_known" CHECK ("underlying_asset_code" IN ('USDC', 'EURC')),
  CONSTRAINT "hot_float_backing_runs_state_known" CHECK ("state" IN ('ok', 'drift', 'error')),
  CONSTRAINT "hot_float_backing_runs_threshold_non_negative" CHECK ("threshold_stroops" >= 0),
  -- A computed run (ok/drift) MUST carry all three numeric columns; an
  -- 'error' run leaves them NULL. Keeps an error row structurally
  -- distinguishable from an ok/drift row with legitimately-zero values
  -- (mirrors vault_float_reconciliation_runs_shape, migration 0063).
  CONSTRAINT "hot_float_backing_runs_shape" CHECK (
    ("state" = 'error')
    OR (
      "state" IN ('ok', 'drift')
      AND "recorded_float_stroops" IS NOT NULL
      AND "onchain_usdc_stroops" IS NOT NULL
      AND "shortfall_stroops" IS NOT NULL
    )
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hot_float_backing_runs_network_checked"
  ON "hot_float_backing_runs" ("network", "checked_at");
