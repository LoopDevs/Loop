-- Hardening A6 — admin-mediated late-deposit refund-to-sender.
-- A deposit that lands just after its order expires is recorded in
-- payment_watcher_skips and abandoned (with an attributed Discord
-- alert). This lets an operator refund such a deposit back to its
-- on-chain sender: the refund is tracked on the skip row itself
-- (`refund_tx_hash` + two new status values) rather than a new table.
--
--   abandoned --claim--> refunding --submit ok--> refunded
--                            \--submit fail--> abandoned (released)
ALTER TABLE "payment_watcher_skips"
  ADD COLUMN IF NOT EXISTS "refund_tx_hash" text;

ALTER TABLE "payment_watcher_skips"
  DROP CONSTRAINT IF EXISTS "payment_watcher_skips_status_known";
ALTER TABLE "payment_watcher_skips"
  ADD CONSTRAINT "payment_watcher_skips_status_known"
  CHECK ("status" IN ('pending', 'resolved', 'abandoned', 'refunding', 'refunded'));
