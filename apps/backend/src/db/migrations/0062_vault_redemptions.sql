-- ADR 031 §Detailed design D6 (V4, migration 0062) — the vault
-- WITHDRAW/REDEEM flow + hot float for LOOPUSD/LOOPEUR. Builds on V1
-- (migration 0060, `loop_vaults`), V2 (`credits/vaults/vault-client.ts`
-- — `withdrawFromVault` / `transferShares`), and V3 (migration 0061,
-- `vault_emissions` + the currency-scoped `assert_emission_conservation`
-- trigger). This migration:
--
--   1. Adds `vault_redemptions` — the durable idempotency + state-
--      machine table for one "spend the vault balance" event (a
--      gift-card purchase via `paymentMethod='loop_asset'` today;
--      `source_type='withdrawal'` is scaffolded for a future fiat
--      off-ramp but has no live writer yet — ADR 036 marks fiat
--      withdrawal a future redemption target). State machine:
--      `pending -> collecting -> redeemed -> settled` (+ `failed`),
--      per `credits/vaults/vault-redemptions.ts`'s doc comment for
--      the full per-state contract (the sub-step resume markers —
--      `shares_to_redeem` / `collect_tx_hash` / `payout_path` /
--      `redeem_tx_hash` — let a single `collecting` DB state cover
--      both "collect landed, not yet paid" and "paid, not yet
--      mirrored" without needing a state per micro-step, mirroring
--      how `vault_emissions.min_shares_used` records an audit value
--      without being a state name).
--   2. Adds `vault_hot_float` — one row per (asset_code, network)
--      tracking the operator's canonical-asset (USDC/EURC) float
--      balance (fiat-minor-denominated, matching `vault_redemptions.
--      value_minor`'s convention) plus `pending_unredeemed_shares`
--      (vault shares the operator holds from FAST-path collects that
--      have not yet been redeemed via a batched `vault.withdraw`).
--      Starts at zero for every vault — an operator seed/top-up
--      endpoint is deliberately NOT built in V4 (mirrors V1 shipping
--      `loop_vaults` empty); every redemption still settles correctly
--      via the SLOW path (a synchronous `vault.withdraw`) until the
--      float organically grows from slow-path replenishment.
--
-- No change to `assert_emission_conservation` (migration 0044,
-- widened by 0061) or `loop_asset_mirror_currency` — this migration
-- reuses the EXISTING `pending_payouts kind='burn'` audit primitive
-- (already accepted for LOOPUSD/LOOPEUR by migration 0061's widened
-- CHECKs, already counted in the trigger's `burned_stroops`
-- aggregation) rather than adding a new payout kind. See
-- `credits/vaults/vault-redemptions.ts`'s mirror step.
--
-- Gated end-to-end: `LOOP_VAULTS_ENABLED=false` (default) AND
-- `LOOP_PHASE_1_ONLY=true` (default) together mean `orders/redeem.ts`
-- never forks into the vault path — the classic loop_asset redemption
-- (`markOrderPaid`'s debit + `kind='burn'` enqueue) is byte-identical
-- to pre-migration. This migration moves no value by itself.

CREATE TABLE IF NOT EXISTS "vault_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_type" text NOT NULL,
  "source_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "asset_code" text NOT NULL,
  "network" text NOT NULL,
  "value_minor" bigint NOT NULL,
  "from_address" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "shares_to_redeem" bigint,
  -- Money-review P1-B: per-step COLLECT claim lease. A driver stamps
  -- this (an atomic state-CAS committed BEFORE the user-signed share
  -- transfer's network call) so exactly one driver submits the collect
  -- even though `state='collecting'` alone does not serialize
  -- processing (the HTTP inline drive + the sweep can both reach a
  -- `collecting` row). Re-acquirable once stale (past the lease) so a
  -- crashed collector doesn't wedge the row. Mirrors V3's
  -- `pending->depositing` deposit CAS, adapted to the extra HTTP driver.
  "collect_claimed_at" timestamp with time zone,
  "collect_tx_hash" text,
  "payout_path" text,
  "redeem_tx_hash" text,
  "pending_payout_id" uuid,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "collected_at" timestamp with time zone,
  "redeemed_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  CONSTRAINT "vault_redemptions_source_type_known" CHECK ("source_type" IN ('order_redeem', 'withdrawal')),
  CONSTRAINT "vault_redemptions_asset_code_known" CHECK ("asset_code" IN ('LOOPUSD', 'LOOPEUR')),
  CONSTRAINT "vault_redemptions_network_known" CHECK ("network" IN ('testnet', 'mainnet')),
  CONSTRAINT "vault_redemptions_state_known" CHECK ("state" IN ('pending', 'collecting', 'redeemed', 'settled', 'failed')),
  CONSTRAINT "vault_redemptions_value_positive" CHECK ("value_minor" > 0),
  CONSTRAINT "vault_redemptions_attempts_non_negative" CHECK ("attempts" >= 0),
  CONSTRAINT "vault_redemptions_from_address_format" CHECK ("from_address" ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT "vault_redemptions_payout_path_known" CHECK ("payout_path" IS NULL OR "payout_path" IN ('fast', 'slow')),
  CONSTRAINT "vault_redemptions_state_shape" CHECK (
    ("state" = 'pending')
    OR ("state" = 'collecting')
    OR (
      "state" = 'redeemed'
      AND "collect_tx_hash" IS NOT NULL
      AND "shares_to_redeem" IS NOT NULL
      AND "payout_path" IS NOT NULL
      AND "redeemed_at" IS NOT NULL
      AND ("payout_path" != 'slow' OR "redeem_tx_hash" IS NOT NULL)
    )
    OR (
      "state" = 'settled'
      AND "collect_tx_hash" IS NOT NULL
      AND "shares_to_redeem" IS NOT NULL
      AND "payout_path" IS NOT NULL
      AND "redeemed_at" IS NOT NULL
      AND ("payout_path" != 'slow' OR "redeem_tx_hash" IS NOT NULL)
      AND "settled_at" IS NOT NULL
    )
    OR ("state" = 'failed')
  )
);
--> statement-breakpoint

ALTER TABLE "vault_redemptions" ADD CONSTRAINT "vault_redemptions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "vault_redemptions" ADD CONSTRAINT "vault_redemptions_pending_payout_id_pending_payouts_id_fk"
  FOREIGN KEY ("pending_payout_id") REFERENCES "pending_payouts"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- The durable claim fence — one vault redemption per (source_type,
-- source_id), ever. For 'order_redeem' rows, source_id is the order
-- id (no FK to `orders` — `source_id` is polymorphic across source
-- types, same reasoning `credit_transactions.reference_id` already
-- uses for its polymorphic reference).
CREATE UNIQUE INDEX IF NOT EXISTS "vault_redemptions_source_unique"
  ON "vault_redemptions" ("source_type", "source_id");
--> statement-breakpoint

-- Sweep query shape: `WHERE state IN (...) ORDER BY created_at`.
CREATE INDEX IF NOT EXISTS "vault_redemptions_state_created"
  ON "vault_redemptions" ("state", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vault_hot_float" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_code" text NOT NULL,
  "network" text NOT NULL,
  "balance_minor" bigint NOT NULL DEFAULT 0,
  "pending_unredeemed_shares" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_hot_float_asset_code_known" CHECK ("asset_code" IN ('LOOPUSD', 'LOOPEUR')),
  CONSTRAINT "vault_hot_float_network_known" CHECK ("network" IN ('testnet', 'mainnet')),
  CONSTRAINT "vault_hot_float_balance_non_negative" CHECK ("balance_minor" >= 0),
  CONSTRAINT "vault_hot_float_pending_shares_non_negative" CHECK ("pending_unredeemed_shares" >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "vault_hot_float_asset_network_unique"
  ON "vault_hot_float" ("asset_code", "network");
