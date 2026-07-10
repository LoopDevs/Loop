-- ADR 031 §Detailed design D3 (2026-07-10 build-ready spec): V1
-- foundation for the LOOPUSD/LOOPEUR DeFindex-vault subsystem —
-- schema only. This migration moves NO value: `loop_vaults` ships
-- EMPTY (the operator inserts the deployed vault addresses post-deploy
-- per §D9 step 1/6; no admin write endpoint exists yet) and every read
-- of it goes through `credits/vaults/registry.ts`, which additionally
-- gates on `LOOP_VAULTS_ENABLED` (default false) — an empty table +
-- flag off is a byte-identical no-op versus pre-migration.
--
-- `loop_vaults` — registry, one row per (asset_code, network): the
-- deployed DeFindex vault instance backing LOOPUSD or LOOPEUR on that
-- network. GBPLOOP is deliberately excluded — it's a classic 1:1
-- asset with its own interest-mint path (migration 0041), not a
-- DeFindex vault (ADR 031 §Decision).
CREATE TABLE IF NOT EXISTS "loop_vaults" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_code" text NOT NULL,
  "vault_contract_id" text NOT NULL,
  "share_asset_code" text NOT NULL,
  "share_asset_issuer" text NOT NULL,
  "underlying_asset_code" text NOT NULL,
  "underlying_asset_issuer" text NOT NULL,
  "strategy_id" text NOT NULL,
  "network" text NOT NULL,
  "fee_bps" integer NOT NULL,
  "active" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "loop_vaults_asset_code_known" CHECK ("asset_code" IN ('LOOPUSD', 'LOOPEUR')),
  CONSTRAINT "loop_vaults_network_known" CHECK ("network" IN ('testnet', 'mainnet'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "loop_vaults_asset_network_unique"
  ON "loop_vaults" ("asset_code", "network");

-- `vault_share_price_snapshots` — feeds the past-30-day APY
-- computation (ADR 031 §D8, a later PR). `share_price_ppm` is the
-- share price in parts-per-million of the underlying asset (e.g.
-- 1_050_000 = 1.05 underlying per share). `source_ledger` is nullable
-- so an off-chain/manual snapshot (e.g. a backfill) doesn't need a
-- real ledger sequence.
CREATE TABLE IF NOT EXISTS "vault_share_price_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_code" text NOT NULL,
  "network" text NOT NULL,
  "taken_at" timestamp with time zone DEFAULT now() NOT NULL,
  "share_price_ppm" bigint NOT NULL,
  "source_ledger" bigint
);

CREATE INDEX IF NOT EXISTS "vault_share_price_snapshots_asset_network_taken"
  ON "vault_share_price_snapshots" ("asset_code", "network", "taken_at" DESC);
