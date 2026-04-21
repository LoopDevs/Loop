-- ADR 015: extend orders.payment_method to accept 'loop_asset' — a
-- user paying with one of Loop's own branded Stellar assets (USDLOOP,
-- GBPLOOP, EURLOOP). Which specific asset the payment carries is
-- determined at watcher-match time from the Horizon record's
-- asset_code + asset_issuer pair; the order row just records that the
-- *intent* was a LOOP-branded payment. For stroops-per-cent math the
-- watcher treats any matching LOOP asset as 1:1 with the order's
-- charge_currency (see #338).
--
-- Drop + recreate the CHECK since Postgres has no ALTER CHECK.
ALTER TABLE "orders"
  DROP CONSTRAINT "orders_payment_method_known";--> statement-breakpoint
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_payment_method_known"
  CHECK ("payment_method" IN ('xlm', 'usdc', 'credit', 'loop_asset'));
