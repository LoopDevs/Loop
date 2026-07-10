-- ADR 031 §Detailed design D5 (V3, migration 0061) — the vault
-- cashback-EMISSION flow + conservation mirror for LOOPUSD/LOOPEUR.
-- Builds on V1 (migration 0060, `loop_vaults` / `vault_share_price_
-- snapshots`) and V2 (`credits/vaults/vault-client.ts`, mock-tested,
-- not yet wired into any flow). This migration:
--
--   1. Adds `vault_emissions` — the durable idempotency + state-
--      machine table for one order's vault-path cashback emission
--      (`pending → deposited → transferred → mirrored`, + `failed`).
--      See `db/schema/vaults.ts`'s doc comment on the table for the
--      full state-machine contract.
--   2. Widens `pending_payouts.asset_code` / `.asset_issuer` CHECKs to
--      admit LOOPUSD/LOOPEUR rows (Soroban contract-id issuers) — the
--      vault-emission flow writes an already-`confirmed`,
--      never-worker-submitted `kind='emission'` AUDIT row here purely
--      so the pre-existing `assert_emission_conservation` trigger
--      also guards vault mints (INV-V1, docs/invariants.md).
--   3. `CREATE OR REPLACE`s `assert_emission_conservation()` to map
--      the two new asset codes to their mirror currency. Every
--      previously-tracked fragment (`check-money-invariants.mjs`)
--      survives unchanged; this only ADDS two `WHEN` branches.
--
-- Gated end-to-end: `LOOP_VAULTS_ENABLED=false` (default) means
-- `orders/fulfillment.ts`'s gated fork never claims a `vault_emissions`
-- row and the classic `pending_payouts kind='order_cashback'` path is
-- byte-identical to pre-migration. This migration moves no value by
-- itself — it only adds capacity.

CREATE TABLE IF NOT EXISTS "vault_emissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "asset_code" text NOT NULL,
  "network" text NOT NULL,
  "cashback_minor" bigint NOT NULL,
  "to_address" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "min_shares_used" bigint,
  "deposit_tx_hash" text,
  "shares_minted" bigint,
  "transfer_tx_hash" text,
  "pending_payout_id" uuid,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deposited_at" timestamp with time zone,
  "transferred_at" timestamp with time zone,
  "mirrored_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  CONSTRAINT "vault_emissions_asset_code_known" CHECK ("asset_code" IN ('LOOPUSD', 'LOOPEUR')),
  CONSTRAINT "vault_emissions_network_known" CHECK ("network" IN ('testnet', 'mainnet')),
  CONSTRAINT "vault_emissions_state_known" CHECK ("state" IN ('pending', 'deposited', 'transferred', 'mirrored', 'failed')),
  CONSTRAINT "vault_emissions_cashback_positive" CHECK ("cashback_minor" > 0),
  CONSTRAINT "vault_emissions_attempts_non_negative" CHECK ("attempts" >= 0),
  CONSTRAINT "vault_emissions_to_address_format" CHECK ("to_address" ~ '^G[A-Z2-7]{55}$'),
  CONSTRAINT "vault_emissions_state_shape" CHECK (
    ("state" = 'pending')
    OR ("state" = 'deposited' AND "deposit_tx_hash" IS NOT NULL AND "shares_minted" IS NOT NULL)
    OR ("state" = 'transferred' AND "deposit_tx_hash" IS NOT NULL AND "shares_minted" IS NOT NULL AND "transfer_tx_hash" IS NOT NULL)
    OR ("state" = 'mirrored' AND "deposit_tx_hash" IS NOT NULL AND "shares_minted" IS NOT NULL AND "transfer_tx_hash" IS NOT NULL AND "mirrored_at" IS NOT NULL)
    OR ("state" = 'failed')
  )
);
--> statement-breakpoint

-- Explicit FK constraint names — drizzle-kit's `{table}_{column}_{refTable}_{refColumn}_fk`
-- convention (matches `pending_payouts_order_id_orders_id_fk` etc.), not
-- postgres's bare-`REFERENCES` default `_fkey` suffix, so
-- `check:migration-parity`'s live-catalog-vs-schema.ts diff sees the
-- SAME constraint name drizzle-kit would materialise from
-- `db/schema/vaults.ts`.
ALTER TABLE "vault_emissions" ADD CONSTRAINT "vault_emissions_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "vault_emissions" ADD CONSTRAINT "vault_emissions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "vault_emissions" ADD CONSTRAINT "vault_emissions_pending_payout_id_pending_payouts_id_fk"
  FOREIGN KEY ("pending_payout_id") REFERENCES "pending_payouts"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- The durable claim fence — one vault emission per order, ever
-- (`orders/fulfillment.ts` inserts with `ON CONFLICT (order_id) DO
-- NOTHING`, reusing the SAME order_id the classic path's own
-- `pending_payouts_order_unique` is keyed on).
CREATE UNIQUE INDEX IF NOT EXISTS "vault_emissions_order_unique"
  ON "vault_emissions" ("order_id");
--> statement-breakpoint

-- Sweep query shape: `WHERE state IN (...) ORDER BY created_at`.
CREATE INDEX IF NOT EXISTS "vault_emissions_state_created"
  ON "vault_emissions" ("state", "created_at");
--> statement-breakpoint

-- Widen the two `pending_payouts` CHECKs that pin the classic
-- USDLOOP/GBPLOOP/EURLOOP asset shape so LOOPUSD/LOOPEUR vault-
-- emission audit rows can land (see the migration header). Drizzle
-- doesn't support `ALTER CONSTRAINT`, so DROP + re-ADD under the
-- SAME names — `check-money-invariants.mjs`'s last-write-wins replay
-- treats this as the surviving definition.
ALTER TABLE "pending_payouts" DROP CONSTRAINT IF EXISTS "pending_payouts_asset_code_known";
--> statement-breakpoint
ALTER TABLE "pending_payouts" ADD CONSTRAINT "pending_payouts_asset_code_known"
  CHECK ("asset_code" IN ('USDLOOP', 'GBPLOOP', 'EURLOOP', 'LOOPUSD', 'LOOPEUR'));
--> statement-breakpoint
ALTER TABLE "pending_payouts" DROP CONSTRAINT IF EXISTS "pending_payouts_asset_issuer_format";
--> statement-breakpoint
ALTER TABLE "pending_payouts" ADD CONSTRAINT "pending_payouts_asset_issuer_format"
  CHECK ("asset_issuer" ~ '^[GC][A-Z2-7]{55}$');
--> statement-breakpoint

-- CREATE OR REPLACE `assert_emission_conservation()` (migration
-- 0044) — the `mirror_currency` CASE gains two branches so a
-- `kind='emission'` LOOPUSD/LOOPEUR row (the vault-emission audit
-- trail write, see the migration header) is checked against the SAME
-- (user, USD|EUR) mirror balance a classic USDLOOP/EURLOOP emission
-- would be. Every fragment `check-money-invariants.mjs` tracks for
-- this function survives unchanged.
--
-- SECOND, LOAD-BEARING change: the minted/burned aggregation used to
-- scope `WHERE pp.asset_code = NEW.asset_code` — correct back when
-- exactly one asset code mapped to each mirror currency. Now that
-- USDLOOP *and* LOOPUSD both mirror into 'USD' (EURLOOP/LOOPEUR into
-- 'EUR'), scoping by the bare asset code would let a user accumulate
-- a classic USDLOOP emission AND a LOOPUSD emission that EACH pass
-- the check individually against the SAME shared USD balance —
-- jointly minting up to 2x the mirror liability (an unbacked-mint
-- hole, exactly the class of bug INV-3 exists to close). The
-- aggregation now sums over every asset code that shares
-- NEW.asset_code's mirror currency, not just NEW.asset_code itself.
CREATE OR REPLACE FUNCTION assert_emission_conservation() RETURNS trigger AS $$
DECLARE
  mirror_currency text;
  balance_minor_val bigint;
  minted_stroops bigint;
  burned_stroops bigint;
  net_stroops bigint;
  new_amount_stroops bigint;
BEGIN
  -- Legacy pre-ADR-036 withdrawal-era emissions debited the mirror at
  -- send (their discriminator is the at-send type='withdrawal' ledger
  -- row) — they are excluded from the counted mint set, so a legacy
  -- row (re-)entering the queue contributes nothing to the check.
  -- Fresh inserts have a brand-new id with no ledger row and count in
  -- full.
  SELECT CASE
    WHEN NEW.kind = 'emission' AND EXISTS (
      SELECT 1 FROM credit_transactions ct
      WHERE ct.type = 'withdrawal'
        AND ct.reference_type = 'payout'
        AND ct.reference_id = NEW.id::text
    ) THEN 0
    ELSE NEW.amount_stroops
  END INTO new_amount_stroops;
  mirror_currency := CASE NEW.asset_code
    WHEN 'USDLOOP' THEN 'USD'
    WHEN 'GBPLOOP' THEN 'GBP'
    WHEN 'EURLOOP' THEN 'EUR'
    WHEN 'LOOPUSD' THEN 'USD'
    WHEN 'LOOPEUR' THEN 'EUR'
    ELSE NULL
  END;
  IF mirror_currency IS NULL THEN
    RAISE EXCEPTION 'emission_conservation: unknown LOOP asset code % — no mirror currency to check against', NEW.asset_code
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT uc.balance_minor INTO balance_minor_val
  FROM user_credits uc
  WHERE uc.user_id = NEW.user_id AND uc.currency = mirror_currency
  FOR UPDATE;
  IF NOT FOUND THEN
    balance_minor_val := 0;
  END IF;

  SELECT
    COALESCE(SUM(pp.amount_stroops) FILTER (
      WHERE pp.kind IN ('order_cashback', 'emission', 'interest_mint')
        AND pp.state != 'failed'
        AND pp.compensated_at IS NULL
        AND (
          pp.kind != 'emission'
          OR NOT EXISTS (
            SELECT 1 FROM credit_transactions ct
            WHERE ct.type = 'withdrawal'
              AND ct.reference_type = 'payout'
              AND ct.reference_id = pp.id::text
          )
        )
    ), 0),
    COALESCE(SUM(pp.amount_stroops) FILTER (WHERE pp.kind = 'burn'), 0)
  INTO minted_stroops, burned_stroops
  FROM pending_payouts pp
  WHERE pp.user_id = NEW.user_id
    AND CASE pp.asset_code
      WHEN 'USDLOOP' THEN 'USD'
      WHEN 'GBPLOOP' THEN 'GBP'
      WHEN 'EURLOOP' THEN 'EUR'
      WHEN 'LOOPUSD' THEN 'USD'
      WHEN 'LOOPEUR' THEN 'EUR'
      ELSE NULL
    END = mirror_currency;

  net_stroops := GREATEST(minted_stroops - burned_stroops, 0);
  IF net_stroops + new_amount_stroops > balance_minor_val * 100000 THEN
    RAISE EXCEPTION 'emission_conservation: emission of % stroops for user % (%) would exceed the un-emitted liability — % stroops already materialised on-chain against a mirror balance of % minor',
      new_amount_stroops, NEW.user_id, NEW.asset_code, net_stroops, balance_minor_val
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
