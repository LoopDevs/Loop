-- R3-2 — preserve the exact Horizon operation that funded an order.
--
-- payment_received_horizon_id / payment_received_tx_hash identify the
-- paying operation. For failed-order auto-refunds, the refund path also
-- needs the sender, asset, and amount. Snapshot the parsed Horizon
-- payment record on the order so XLM/USDC failures can be returned to
-- the original on-chain sender through the existing deposit-refund
-- state machine without querying old Horizon history.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "payment_received_payment" jsonb;
