-- T0-1b: persist the Horizon payment operation that funded an order.
--
-- The payment watcher can then safely record a later duplicate deposit
-- against an already-paid order while ignoring a cursor re-read of the
-- original paying deposit.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "payment_received_horizon_id" text;

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "payment_received_tx_hash" text;
