-- 0076_ctx_money_in.sql  (ADR 052 — ctx is the payment processor)
--
-- Reverses ADR 010: Loop no longer takes customer payments. The
-- customer pays CTX directly, CTX fulfils, and Loop earns operator
-- commission. This migration retires the Loop-side money-in machine:
--
--   - drops the deposit-watcher, procurement-settlement, and
--     operator-float tables
--   - strips the payment/procurement columns off `orders` and
--     re-shapes it into a CTX mirror + commission log
--   - maps historical order states onto the mirror enum (hard cut:
--     in-flight money-in rows become `expired`; `failed` maps to
--     `rejected`; `pending_payment` was never paid so it maps to
--     `expired` too)
DROP TABLE IF EXISTS "operator_wallet_movements";--> statement-breakpoint
DROP TABLE IF EXISTS "operator_float_reconciliation_runs";--> statement-breakpoint
DROP TABLE IF EXISTS "operator_wallet_baselines";--> statement-breakpoint
DROP TABLE IF EXISTS "ctx_settlements";--> statement-breakpoint
DROP TABLE IF EXISTS "payment_watcher_skips";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_loop_asset_created";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_paid_procuring_created";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_pending_payment";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_procuring_procured_at";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_payment_memo";--> statement-breakpoint
DROP INDEX IF EXISTS "orders_payment_source_account";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_state_known";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_payment_method_known";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_payment_memo_coherence";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_charge_currency_known";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_percentages_sum";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_percentages_non_negative";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_minor_amounts_non_negative";--> statement-breakpoint
UPDATE "orders" SET "state" = 'expired' WHERE "state" IN ('pending_payment', 'paid', 'procuring');--> statement-breakpoint
UPDATE "orders" SET "state" = 'rejected' WHERE "state" = 'failed';--> statement-breakpoint
UPDATE "orders" SET "state" = 'unpaid' WHERE "state" NOT IN ('unpaid', 'paid', 'fulfilled', 'rejected', 'refunded', 'expired');--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_method";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_memo";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_received_at";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_received_horizon_id";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_received_tx_hash";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "payment_received_payment";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "wholesale_pct";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "user_cashback_pct";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "loop_margin_pct";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "wholesale_minor";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "loop_margin_minor";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "paid_at";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN IF EXISTS "procured_at";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ctx_payment_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_crypto_currency" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "expected_commission_minor" bigint;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "state" SET DEFAULT 'unpaid';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_state_known" CHECK ("state" IN ('unpaid', 'paid', 'fulfilled', 'rejected', 'refunded', 'expired'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_minor_amounts_non_negative" CHECK (
        "face_value_minor" >= 0
        AND "charge_minor" >= 0
        AND "user_cashback_minor" >= 0
        AND ("expected_commission_minor" IS NULL OR "expected_commission_minor" >= 0)
      );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_open_mirror" ON "orders" ("created_at") WHERE "state" IN ('unpaid', 'paid');
