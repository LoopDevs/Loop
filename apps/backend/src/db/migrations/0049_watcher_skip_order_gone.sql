-- T0-1 — stop silently stranding late / duplicate deposits.
--
-- A deposit whose memo maps to a REAL order that's no longer
-- `pending_payment` (the order expired, or was already paid by another
-- payment) was classified `unmatched` by the payment watcher and only
-- counted — never recorded in payment_watcher_skips. Because the A6
-- refund path reads ONLY that table, those funds were unreachable by
-- any refund: stranded at the operator/deposit account with no record,
-- no alert, no refund (falsifying the "funds are never silently lost"
-- guarantee).
--
-- The watcher now records such deposits with a new `order_gone` reason
-- (only when an order actually exists for the memo — a memo matching no
-- order stays a counted no-op, since refunding an unattributable
-- payment is a separate decision). The existing sweep then abandons an
-- `order_gone` row → it lands on /admin/skips, refundable to the
-- on-chain sender via the A6 flow. Widen the reason CHECK to admit it.
ALTER TABLE "payment_watcher_skips"
  DROP CONSTRAINT IF EXISTS "payment_watcher_skips_reason_known";
ALTER TABLE "payment_watcher_skips"
  ADD CONSTRAINT "payment_watcher_skips_reason_known"
  CHECK (
    "reason" IN (
      'asset_mismatch',
      'amount_insufficient',
      'missing_credit_row',
      'processing_error',
      'order_gone'
    )
  );
