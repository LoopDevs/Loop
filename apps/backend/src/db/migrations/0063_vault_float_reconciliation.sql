-- ADR 031 §Detailed design D4 (V5, migration 0063) — audit trail for
-- `treasury/hot-float-reconciliation.ts`'s float/pool desync check.
-- One row per (asset_code, network) per tick, comparing the
-- operator's ACTUAL on-chain vault-share balance against what the
-- bookkeeping says it should currently be holding (in-flight
-- emission-deposited shares + vault_hot_float.pending_unredeemed_shares).
-- This is the reconciler for the V4-accepted "Known residual (NOT
-- self-correcting)" documented under Vault redemptions in
-- docs/invariants.md — no other table tracks this check's history.
--
-- Gated end-to-end: with LOOP_VAULTS_ENABLED=false (default) the
-- reconciliation never runs and this table stays empty — this
-- migration moves no value and changes no existing behaviour.

CREATE TABLE IF NOT EXISTS "vault_float_reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_code" text NOT NULL,
  "network" text NOT NULL,
  "operator_share_balance" bigint,
  "expected_operator_shares" bigint,
  "share_delta" bigint,
  "threshold_shares" bigint NOT NULL,
  "state" text NOT NULL,
  "error" text,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_float_reconciliation_runs_asset_code_known" CHECK ("asset_code" IN ('LOOPUSD', 'LOOPEUR')),
  CONSTRAINT "vault_float_reconciliation_runs_network_known" CHECK ("network" IN ('testnet', 'mainnet')),
  CONSTRAINT "vault_float_reconciliation_runs_state_known" CHECK ("state" IN ('ok', 'drift', 'error')),
  CONSTRAINT "vault_float_reconciliation_runs_threshold_non_negative" CHECK ("threshold_shares" >= 0),
  -- A computed run (ok/drift) MUST carry all three numeric columns; an
  -- 'error' run leaves them NULL. Keeps an error row structurally
  -- distinguishable from an ok/drift row with legitimately-zero values.
  CONSTRAINT "vault_float_reconciliation_runs_shape" CHECK (
    ("state" = 'error')
    OR (
      "state" IN ('ok', 'drift')
      AND "operator_share_balance" IS NOT NULL
      AND "expected_operator_shares" IS NOT NULL
      AND "share_delta" IS NOT NULL
    )
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vault_float_reconciliation_runs_asset_network_checked"
  ON "vault_float_reconciliation_runs" ("asset_code", "network", "checked_at");
