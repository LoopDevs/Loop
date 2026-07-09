-- AUDIT-2 finding C — stop silently dropping unrecognized inbound deposits.
--
-- The payment watcher's outcome switch had a bare `break;` for both the
-- `no_match` and `no_memo` cases: a payment that DELIVERED value to the
-- deposit address (a successful payment/path-payment op, `to === account`)
-- but matched no configured rail — wrong/no memo, or an asset/issuer/amount
-- no order or allowlist recognizes — got no DB row of any kind. The Horizon
-- cursor still advanced past it (the watcher processes strictly forward), so
-- there was no automatic re-scan: real value landed at Loop's custody with
-- no recovery trail, and the order it should have paid expired in 24h.
--
-- Root causes, both closed by this change's application code:
--   (a) `horizon.ts` gated matching on `p.type === 'payment'` alone, so a
--       real user funding a deposit via a path payment (a normal wallet
--       auto-route through the DEX) was excluded outright.
--   (b) the memo-type check was folded into the same boolean as the
--       asset-matching, so a correctly-addressed, correctly-sized payment
--       with no text memo was indistinguishable from "wrong asset".
--
-- The watcher now records such deposits with a new `unrecognized_deposit`
-- reason — ONLY when the operation actually delivered value TO the deposit
-- address (never for the SAME account's routine outbound operator payments/
-- payouts, which also appear in this feed as a non-match and must not flood
-- this table with noise) and above the existing dust floor. Widen the
-- reason CHECK to admit it — same shape as migration 0049's `order_gone`
-- addition.
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
      'order_gone',
      'unrecognized_deposit'
    )
  );
